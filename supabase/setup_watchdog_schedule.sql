-- Run once in the Supabase SQL Editor AFTER setup_push_notifications.sql and AFTER deploying the push-enabled
-- /api/watchdog with FIREBASE_SERVICE_ACCOUNT_JSON set. pg_cron + pg_net call it every hour (Vercel Hobby crons
-- run at most once per day). It reuses the Vault secrets created for setup_prediction_schedule.sql, so
-- CRON_SECRET in Vercel must match 'predict_watering_cron_secret'.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'push-watchdog',
  '5 * * * *',
  $job$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'predict_watering_base_url')
      || '/api/watchdog',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'predict_watering_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $job$
);

select cron.schedule(
  'prune-notification-incidents',
  '45 3 * * *',
  $job$delete from public.notification_incidents where closed_at < now() - interval '90 days'$job$
);

-- Diagnostics:
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select id, status_code, error_msg, content::text, created from net._http_response order by created desc limit 10;
--   select * from public.notification_incidents order by opened_at desc limit 20;
