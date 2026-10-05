-- Run once in the Supabase SQL Editor BEFORE deploying the push-enabled /api/watchdog.
-- notification_incidents is the watchdog's memory between runs: one row per open problem, so every
-- incident is announced once and a new push is possible only after the problem was closed.
--
-- kind                  pot_id      meaning
-- pot_disconnected      pot         DISCONNECTION alert (see api/_lib/alerts.js)
-- all_pots_disconnected null        every pot that ever reported has lost signal
-- watering_due          pot         next_watered_date <= now
--
-- suppressed = opened silently (a per-pot disconnect during an aggregate outage), never sent.
-- notified_at null + attempts < 3 on an open, non-suppressed row = delivery is retried on the next run.

create table if not exists public.notification_incidents (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('pot_disconnected', 'all_pots_disconnected', 'watering_due')),
  pot_id uuid references public.pots (id) on delete cascade,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  suppressed boolean not null default false,
  notified_at timestamptz,
  attempts smallint not null default 0,
  check ((kind = 'all_pots_disconnected') = (pot_id is null))
);

-- At most one open incident per (kind, pot); also the guard against two concurrent watchdog runs.
create unique index if not exists notification_incidents_open_uq
  on public.notification_incidents (kind, coalesce(pot_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where closed_at is null;

alter table public.notification_incidents enable row level security;

grant all on table public.notification_incidents to service_role;
grant usage, select on sequence public.notification_incidents_id_seq to service_role;
