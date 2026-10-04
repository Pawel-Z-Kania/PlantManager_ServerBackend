-- Run once in the Supabase SQL Editor after the two watering migrations. Supabase pg_cron + pg_net
-- call GET /api/predict-watering every 3 hours (Vercel Hobby crons are limited to once per day).
--
-- Step 1 (run manually, once; replace the placeholders, never commit real values):
--   select vault.create_secret('https://<your-vercel-domain>', 'predict_watering_base_url');
--   select vault.create_secret('<the same value as CRON_SECRET in Vercel>', 'predict_watering_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'predict-watering',
  '15 */3 * * *',
  $job$
  select net.http_get(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'predict_watering_base_url')
      || '/api/predict-watering',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'predict_watering_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $job$
);

select cron.schedule(
  'prune-watering-prediction-log',
  '30 3 * * *',
  $job$delete from public.watering_prediction_log where computed_at < now() - interval '180 days'$job$
);

-- Diagnostics:
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select id, status_code, error_msg, created from net._http_response order by created desc limit 10;
