-- Run once in the Supabase SQL Editor (forward migration). Replaces the "Drop & Hold" logic behind
-- trigger trg_check_watering (AFTER INSERT on pot_measurements -> process_pot_measurement()).
-- The trigger itself is untouched: only the function body is replaced, so rollback = restore the
-- function from the comment block at the bottom of this file.
--
-- Why v1 never fired: it required a 3-sample average drop > 200 ADC, while real waterings drop
-- ~85-160 ADC (soil range ~380-600) and the drop is spread over several 5-minute samples.

-- 1. Tunable detection parameters (singleton). Kept out of system_config on purpose:
--    getSystemConfig() selects '*', so extra columns there would leak into GET /api/config.
create table if not exists public.watering_detection_config (
  id smallint primary key default 1 check (id = 1),
  min_drop_adc integer not null default 50 check (min_drop_adc > 0),
  baseline_window_minutes integer not null default 180 check (baseline_window_minutes between 30 and 1440),
  baseline_gap_minutes integer not null default 10 check (baseline_gap_minutes >= 0),
  confirm_samples integer not null default 3 check (confirm_samples between 2 and 10),
  max_recent_variance numeric not null default 50 check (max_recent_variance > 0),
  cooldown_hours integer not null default 12 check (cooldown_hours >= 0)
);

insert into public.watering_detection_config (id) values (1) on conflict (id) do nothing;

-- 2. Watering history: one row per detected watering (used for interval prediction and calibration).
create table if not exists public.watering_events (
  id bigint generated always as identity primary key,
  pot_id uuid not null references public.pots (id) on delete cascade,
  watered_at timestamptz not null,
  adc_before integer,
  adc_after integer,
  detected_at timestamptz not null default now(),
  unique (pot_id, watered_at)
);

create index if not exists watering_events_pot_id_watered_at_idx
  on public.watering_events (pot_id, watered_at desc);

alter table public.watering_detection_config enable row level security;
alter table public.watering_events enable row level security;

grant all on table public.watering_detection_config to service_role;
grant all on table public.watering_events to service_role;
grant usage, select on sequence public.watering_events_id_seq to service_role;

-- 3. Index (pot_id, measured_at) is required by the trigger, the history RPC and the prediction RPC.
--    Created only if no index with these two leading columns exists yet.
do $$
begin
  if not exists (
    select 1
    from pg_index as i
    where i.indrelid = 'public.pot_measurements'::regclass
      and i.indisvalid
      and (
        select array_agg(a.attname::text order by k.ord)
        from unnest(i.indkey::int2[]) with ordinality as k (attnum, ord)
        join pg_attribute as a on a.attrelid = i.indrelid and a.attnum = k.attnum
        where k.ord <= 2
      ) = array['pot_id', 'measured_at']
  ) then
    create index pot_measurements_pot_id_measured_at_idx
      on public.pot_measurements (pot_id, measured_at);
  end if;
end;
$$;

-- 4. Pure detection logic, shared by the trigger and the backfill below.
--    Detected = the mean of the last N samples is more than min_drop_adc below the mean of the
--    preceding baseline window, the last N samples are stable, and the cooldown has elapsed.
--    onset = first sample after the last "dry" sample (value within 25% of the drop from baseline).
--    The baseline window is anchored to the last sample before the recent samples, so a data gap
--    (device offline) does not disable detection.
create or replace function public.detect_watering(
  p_pot_id uuid,
  p_at timestamptz,
  p_last_watered_at timestamptz default null
)
returns table (
  onset timestamptz,
  baseline_avg numeric,
  recent_avg numeric
)
language plpgsql
stable
set search_path = public
as $$
declare
  cfg public.watering_detection_config%rowtype;
  v_recent_avg numeric;
  v_recent_variance numeric;
  v_recent_count integer;
  v_recent_start timestamptz;
  v_pre_end timestamptz;
  v_baseline_avg numeric;
  v_dry_floor numeric;
  v_last_dry timestamptz;
  v_onset timestamptz;
begin
  select * into cfg from public.watering_detection_config where id = 1;
  if not found then
    raise warning 'watering_detection_config row is missing, watering detection is disabled';
    return;
  end if;

  if p_last_watered_at is not null
      and p_at < p_last_watered_at + make_interval(hours => cfg.cooldown_hours) then
    return;
  end if;

  select avg(r.sensor_value), coalesce(variance(r.sensor_value), 0), count(*)::integer, min(r.measured_at)
  into v_recent_avg, v_recent_variance, v_recent_count, v_recent_start
  from (
    select m.sensor_value, m.measured_at
    from pot_measurements as m
    where m.pot_id = p_pot_id and m.measured_at <= p_at
    order by m.measured_at desc, m.id desc
    limit cfg.confirm_samples
  ) as r;

  if v_recent_count < cfg.confirm_samples or v_recent_variance >= cfg.max_recent_variance then
    return;
  end if;

  select max(m.measured_at) into v_pre_end
  from pot_measurements as m
  where m.pot_id = p_pot_id
    and m.measured_at < v_recent_start - make_interval(mins => cfg.baseline_gap_minutes);

  if v_pre_end is null then
    return;
  end if;

  select avg(m.sensor_value) into v_baseline_avg
  from pot_measurements as m
  where m.pot_id = p_pot_id
    and m.measured_at >= v_pre_end - make_interval(mins => cfg.baseline_window_minutes)
    and m.measured_at <= v_pre_end;

  if v_baseline_avg - v_recent_avg <= cfg.min_drop_adc then
    return;
  end if;

  v_dry_floor := v_baseline_avg - 0.25 * (v_baseline_avg - v_recent_avg);

  select max(m.measured_at) into v_last_dry
  from pot_measurements as m
  where m.pot_id = p_pot_id
    and m.measured_at >= v_pre_end - make_interval(mins => cfg.baseline_window_minutes)
    and m.measured_at <= p_at
    and m.sensor_value >= v_dry_floor;

  select min(m.measured_at) into v_onset
  from pot_measurements as m
  where m.pot_id = p_pot_id
    and m.measured_at <= p_at
    and m.measured_at > coalesce(v_last_dry, v_recent_start - interval '1 microsecond');

  if v_onset is null or (p_last_watered_at is not null and v_onset <= p_last_watered_at) then
    return;
  end if;

  return query select v_onset, v_baseline_avg, v_recent_avg;
end;
$$;

revoke execute on function public.detect_watering(uuid, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.detect_watering(uuid, timestamptz, timestamptz) to service_role;

-- 5. Trigger function (same name/signature as the deployed one, so trg_check_watering keeps working).
--    wet_calibration_value keeps the v1 EMA (alpha 0.2) over the settled recent average.
create or replace function public.process_pot_measurement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_last_watered_at timestamptz;
  v_detection record;
  v_ema_alpha constant numeric := 0.2;
begin
  if new.pot_id is null or new.measured_at is null then
    return new;
  end if;

  select pots.last_watered_at into v_last_watered_at from pots where pots.id = new.pot_id;

  select * into v_detection from detect_watering(new.pot_id, new.measured_at, v_last_watered_at);

  if v_detection.onset is null then
    return new;
  end if;

  update pots
  set
    last_watered_at = v_detection.onset,
    next_watered_date = null,
    wet_calibration_value = coalesce(
      (wet_calibration_value * (1 - v_ema_alpha)) + (v_detection.recent_avg * v_ema_alpha),
      v_detection.recent_avg
    )
  where id = new.pot_id;

  insert into watering_events (pot_id, watered_at, adc_before, adc_after)
  values (
    new.pot_id,
    v_detection.onset,
    round(v_detection.baseline_avg),
    round(v_detection.recent_avg)
  )
  on conflict (pot_id, watered_at) do nothing;

  return new;
end;
$$;

-- 6. One-time backfill of watering_events and pots.last_watered_at from the last 90 days.
--    Candidate rows are pre-filtered with a window function so detect_watering() runs only inside
--    drop episodes. wet_calibration_value is intentionally not touched retroactively.
do $$
declare
  cfg public.watering_detection_config%rowtype;
  v_since constant timestamptz := now() - interval '90 days';
  v_candidate record;
  v_detection record;
  v_pot_id uuid;
  v_last_watered_at timestamptz;
begin
  select * into cfg from public.watering_detection_config where id = 1;
  if not found then
    raise exception 'watering_detection_config row is missing';
  end if;

  for v_candidate in
    with windowed as (
      select
        m.pot_id,
        m.measured_at,
        m.sensor_value,
        max(m.sensor_value) over (
          partition by m.pot_id
          order by m.measured_at
          range between make_interval(mins => cfg.baseline_window_minutes) preceding
                    and interval '1 microsecond' preceding
        ) as previous_max
      from public.pot_measurements as m
      where m.pot_id is not null
        and m.measured_at >= v_since
    )
    select w.pot_id, w.measured_at
    from windowed as w
    where w.previous_max is not null
      and w.sensor_value <= w.previous_max - cfg.min_drop_adc / 2.0
    order by w.pot_id, w.measured_at
  loop
    if v_pot_id is distinct from v_candidate.pot_id then
      v_pot_id := v_candidate.pot_id;
      v_last_watered_at := null;
    end if;

    select * into v_detection
    from public.detect_watering(v_candidate.pot_id, v_candidate.measured_at, v_last_watered_at);

    if v_detection.onset is not null then
      insert into public.watering_events (pot_id, watered_at, adc_before, adc_after)
      values (
        v_candidate.pot_id,
        v_detection.onset,
        round(v_detection.baseline_avg),
        round(v_detection.recent_avg)
      )
      on conflict (pot_id, watered_at) do nothing;

      v_last_watered_at := v_detection.onset;
    end if;
  end loop;

  update public.pots as p
  set last_watered_at = e.last_event
  from (
    select pot_id, max(watered_at) as last_event
    from public.watering_events
    group by pot_id
  ) as e
  where p.id = e.pot_id and p.last_watered_at is null;
end;
$$;

/* Rollback: previous process_pot_measurement() body (v1 Drop & Hold).

create or replace function public.process_pot_measurement()
returns trigger
language plpgsql
as $$
declare
  avg_recent float;
  avg_past float;
  variance_recent float;
  delta_threshold int := 200;
  ema_alpha float := 0.2;
begin
  select avg(sensor_value), coalesce(variance(sensor_value), 0)
  into avg_recent, variance_recent
  from (
    select sensor_value from pot_measurements
    where pot_id = new.pot_id
    order by measured_at desc limit 3
  ) recent_data;

  select avg(sensor_value) into avg_past
  from (
    select sensor_value from pot_measurements
    where pot_id = new.pot_id
    order by measured_at desc offset 3 limit 3
  ) past_data;

  if avg_past is not null and (avg_past - avg_recent) > delta_threshold and variance_recent < 50 then
    update pots
    set
      last_watered_at = new.measured_at,
      next_watered_date = null,
      wet_calibration_value = coalesce(
        (wet_calibration_value * (1 - ema_alpha)) + (avg_recent * ema_alpha),
        avg_recent
      )
    where id = new.pot_id;
  end if;

  return new;
end;
$$;
*/
