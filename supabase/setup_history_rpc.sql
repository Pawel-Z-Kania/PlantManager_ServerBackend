-- Run once in the Supabase SQL Editor before deploying the RPC-based Vercel handlers.

create or replace function public.accept_measurement(
  p_pot_id uuid,
  p_sensor_value integer,
  p_battery_mv smallint
)
returns table (
  saved boolean,
  measurement_id bigint,
  sensor_sample_interval_sec integer,
  retry_after_sec integer,
  measured_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_interval_sec integer;
  v_latest_measured_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_measurement_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_pot_id::text, 0));

  select config.sensor_sample_interval_sec
  into v_interval_sec
  from system_config as config
  where config.id = 1;

  if v_interval_sec is null or v_interval_sec <= 0 then
    raise exception 'Invalid system_config.sensor_sample_interval_sec';
  end if;

  select pot_measurements.measured_at
  into v_latest_measured_at
  from pot_measurements
  where pot_measurements.pot_id = p_pot_id
  order by pot_measurements.measured_at desc, pot_measurements.id desc
  limit 1;

  if v_latest_measured_at is not null
      and v_now < v_latest_measured_at + make_interval(secs => v_interval_sec) then
    return query
    select
      false,
      null::bigint,
      v_interval_sec,
      greatest(1, ceil(extract(epoch from v_latest_measured_at + make_interval(secs => v_interval_sec) - v_now))::integer),
      v_latest_measured_at;
    return;
  end if;

  insert into pot_measurements (pot_id, sensor_value, battery_mv, measured_at)
  values (p_pot_id, p_sensor_value, p_battery_mv, v_now)
  returning id into v_measurement_id;

  return query select true, v_measurement_id, v_interval_sec, null::integer, v_now;
end;
$$;

create or replace function public.get_pot_history(
  p_pot_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_bucket_minutes integer default 0
)
returns table (
  sensor_value integer,
  measured_at timestamptz,
  average_value numeric,
  min_value integer,
  max_value integer,
  sample_count bigint,
  bucket_start timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_from >= p_to then
    raise exception 'p_from must be earlier than p_to';
  end if;

  if p_bucket_minutes < 0 or p_bucket_minutes > 1440 then
    raise exception 'p_bucket_minutes must be between 0 and 1440';
  end if;

  if p_bucket_minutes = 0 then
    return query
    select
      measurements.sensor_value,
      measurements.measured_at,
      measurements.sensor_value::numeric,
      measurements.sensor_value,
      measurements.sensor_value,
      1::bigint,
      measurements.measured_at
    from pot_measurements as measurements
    where measurements.pot_id = p_pot_id
      and measurements.measured_at >= p_from
      and measurements.measured_at < p_to
    order by measurements.measured_at asc, measurements.id asc;
    return;
  end if;

  return query
  with bucketed as (
    select
      measurements.id,
      measurements.sensor_value,
      measurements.measured_at,
      to_timestamp(
        floor(extract(epoch from measurements.measured_at) / (p_bucket_minutes * 60))
        * p_bucket_minutes * 60
      ) as grouped_bucket_start
    from pot_measurements as measurements
    where measurements.pot_id = p_pot_id
      and measurements.measured_at >= p_from
      and measurements.measured_at < p_to
  )
  select
    (array_agg(bucket.sensor_value order by bucket.measured_at desc, bucket.id desc))[1] as sensor_value,
    max(bucket.measured_at) as measured_at,
    avg(bucket.sensor_value)::numeric as average_value,
    min(bucket.sensor_value) as min_value,
    max(bucket.sensor_value) as max_value,
    count(*)::bigint as sample_count,
    bucket.grouped_bucket_start as bucket_start
  from bucketed as bucket
  group by bucket.grouped_bucket_start
  order by bucket.grouped_bucket_start asc;
end;
$$;

revoke execute on function public.accept_measurement(uuid, integer, smallint) from public, anon, authenticated;
revoke execute on function public.get_pot_history(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.accept_measurement(uuid, integer, smallint) to service_role;
grant execute on function public.get_pot_history(uuid, timestamptz, timestamptz, integer) to service_role;