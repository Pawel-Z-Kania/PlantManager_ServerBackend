-- Run once in the Supabase SQL Editor before deploying the configuration handlers.

alter table public.system_config
  add column if not exists config_version bigint not null default 1;

update public.system_config
set config_version = 1
where config_version is null or config_version < 1;

insert into public.system_config (
  id,
  config_version,
  battery_critical_mv,
  battery_warning_mv,
  connection_timeout_hours,
  sensor_sample_interval_sec
)
values (1, 1, 2700, 2800, 2, 30)
on conflict (id) do nothing;

create or replace function public.update_system_config(p_config jsonb)
returns setof public.system_config
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_config public.system_config%rowtype;
begin
  update public.system_config
  set
    battery_critical_mv = coalesce((p_config ->> 'battery_critical_mv')::integer, battery_critical_mv),
    battery_warning_mv = coalesce((p_config ->> 'battery_warning_mv')::integer, battery_warning_mv),
    connection_timeout_hours = coalesce((p_config ->> 'connection_timeout_hours')::integer, connection_timeout_hours),
    sensor_sample_interval_sec = coalesce((p_config ->> 'sensor_sample_interval_sec')::integer, sensor_sample_interval_sec),
    config_version = config_version + 1
  where id = 1
  returning * into updated_config;

  return next updated_config;
end;
$$;