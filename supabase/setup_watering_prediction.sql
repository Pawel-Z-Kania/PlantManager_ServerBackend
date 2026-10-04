-- Run once in the Supabase SQL Editor AFTER setup_watering_detection_v2.sql (needs watering_events).
-- Adds plant types, prediction input/output RPCs and the prediction log.

-- 1. Plant profiles. target_logit = ln(p / (1 - p)), where p is the drying progress at which the
--    plant should be watered; the predicted time is t_m + target_logit / k on the fitted logistic
--    curve (so it does not depend on absolute ADC levels or on the calibration values).
create table if not exists public.plant_types (
  code text primary key,
  label_pl text not null,
  target_logit numeric not null,
  smoothing_window_hours numeric not null default 12 check (smoothing_window_hours > 0),
  settle_hours numeric not null default 12 check (settle_hours >= 0),
  min_cycle_age_hours numeric not null default 48 check (min_cycle_age_hours >= 0),
  sort_order smallint not null default 0
);

-- Only 'strelicja' is calibrated (2 completed cycles, backtest on the fitted curve, in-sample);
-- the other values are untested heuristics to be tuned from watering_prediction_log.
insert into public.plant_types (code, label_pl, target_logit, sort_order) values
  ('strelicja', 'Strelicja', 2.6, 10),
  ('epipremnum', 'Epipremnum', 1.7, 20),
  ('calathea', 'Calathea', -0.2, 30),
  ('coleus', 'Coleus', 0.2, 40),
  ('ficus', 'Ficus', 1.1, 50),
  ('hoya', 'Hoya', 2.9, 60),
  ('aglaonema', 'Aglaonema', 2.0, 70),
  ('unknown', 'Nieokreślony', 1.1, 999)
on conflict (code) do nothing;

alter table public.pots
  add column if not exists plant_type text not null default 'unknown'
  references public.plant_types (code) on update cascade;

-- 2. Prediction log (calibration data: predicted vs. the next real watering in watering_events).
create table if not exists public.watering_prediction_log (
  id bigint generated always as identity primary key,
  pot_id uuid not null references public.pots (id) on delete cascade,
  computed_at timestamptz not null default now(),
  cycle_started_at timestamptz not null,
  plant_type text,
  source text not null check (source in ('curve', 'interval')),
  predicted_date timestamptz not null,
  details jsonb not null default '{}'::jsonb
);

create index if not exists watering_prediction_log_pot_cycle_idx
  on public.watering_prediction_log (pot_id, cycle_started_at, computed_at desc);

alter table public.plant_types enable row level security;
alter table public.watering_prediction_log enable row level security;

grant all on table public.plant_types to service_role;
grant all on table public.watering_prediction_log to service_role;
grant usage, select on sequence public.watering_prediction_log_id_seq to service_role;

-- 3. One row per pot with an open cycle: profile, hourly means since last_watered_at and event history.
--    points = [[mean_epoch_sec, mean_adc], ...]; events = [epoch_sec, ...] ascending.
--    Returned as jsonb per pot to stay under the PostgREST max-rows limit (default 1000).
create or replace function public.get_watering_curve_inputs(p_bucket_minutes integer default 60)
returns table (
  pot_id uuid,
  plant_type text,
  last_watered_at timestamptz,
  next_watered_date timestamptz,
  target_logit numeric,
  smoothing_window_hours numeric,
  settle_hours numeric,
  min_cycle_age_hours numeric,
  points jsonb,
  events jsonb
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_bucket_minutes < 5 or p_bucket_minutes > 240 then
    raise exception 'p_bucket_minutes must be between 5 and 240';
  end if;

  return query
  select
    p.id,
    p.plant_type,
    p.last_watered_at,
    p.next_watered_date,
    t.target_logit,
    t.smoothing_window_hours,
    t.settle_hours,
    t.min_cycle_age_hours,
    coalesce((
      select jsonb_agg(jsonb_build_array(b.mean_epoch, b.mean_value) order by b.mean_epoch)
      from (
        select
          avg(extract(epoch from m.measured_at))::float8 as mean_epoch,
          avg(m.sensor_value)::float8 as mean_value
        from pot_measurements as m
        where m.pot_id = p.id
          and m.measured_at > p.last_watered_at
        group by floor(extract(epoch from m.measured_at) / (p_bucket_minutes * 60))
      ) as b
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(extract(epoch from e.watered_at)::float8 order by e.watered_at)
      from watering_events as e
      where e.pot_id = p.id
    ), '[]'::jsonb)
  from pots as p
  join plant_types as t on t.code = p.plant_type
  where p.last_watered_at is not null;
end;
$$;

-- 4. Batch write: one UPDATE ... FROM statement (one transaction). The write is skipped when
--    last_watered_at changed meanwhile (a new watering resets the cycle), and the log row is
--    inserted atomically with the update.
--    p_predictions = [{pot_id, expected_last_watered_at, next_watered_date, source, details}, ...]
create or replace function public.apply_watering_predictions(p_predictions jsonb)
returns table (
  received integer,
  applied integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_received integer;
  v_applied integer;
begin
  if jsonb_typeof(p_predictions) is distinct from 'array' then
    raise exception 'p_predictions must be a JSON array';
  end if;

  v_received := jsonb_array_length(p_predictions);

  with input as (
    select
      (item ->> 'pot_id')::uuid as pot_id,
      (item ->> 'expected_last_watered_at')::timestamptz as expected_last_watered_at,
      (item ->> 'next_watered_date')::timestamptz as next_watered_date,
      item ->> 'source' as source,
      coalesce(item -> 'details', '{}'::jsonb) as details
    from jsonb_array_elements(p_predictions) as item
  ),
  updated as (
    update pots as p
    set next_watered_date = i.next_watered_date
    from input as i
    where p.id = i.pot_id
      and date_trunc('milliseconds', p.last_watered_at) = date_trunc('milliseconds', i.expected_last_watered_at)
      and p.next_watered_date is distinct from i.next_watered_date
    returning p.id, p.last_watered_at, p.plant_type, i.next_watered_date, i.source, i.details
  ),
  logged as (
    insert into watering_prediction_log (pot_id, cycle_started_at, plant_type, source, predicted_date, details)
    select u.id, u.last_watered_at, u.plant_type, u.source, u.next_watered_date, u.details
    from updated as u
    returning 1
  )
  select count(*)::integer into v_applied from logged;

  return query select v_received, v_applied;
end;
$$;

revoke execute on function public.get_watering_curve_inputs(integer) from public, anon, authenticated;
revoke execute on function public.apply_watering_predictions(jsonb) from public, anon, authenticated;
grant execute on function public.get_watering_curve_inputs(integer) to service_role;
grant execute on function public.apply_watering_predictions(jsonb) to service_role;
