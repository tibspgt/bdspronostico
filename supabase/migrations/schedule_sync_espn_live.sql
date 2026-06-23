-- Appelle la fonction "sync-espn-live" toutes les 2 minutes, uniquement
-- pendant la fenêtre des matchs : 16:00–07:59 UTC = 18:00–09:59 CEST.
-- (Coup d'envoi le plus tôt 18:00 CEST ; un 8e de finale tardif peut finir
--  vers 09:00 CEST avec prolongations + t.a.b.)
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'sync-espn-live';

select cron.schedule(
  'sync-espn-live',
  '*/2 16-23,0-7 * * *',
  $$
  select net.http_post(
    url     := 'https://godcigantcuuwnwerxjc.supabase.co/functions/v1/sync-espn-live',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvZGNpZ2FudGN1dXdud2VyeGpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNjU5MzYsImV4cCI6MjA5MTc0MTkzNn0.6udFhN0OhzWOGhLoLrD3q2qoS9zey9iHQVCUsdkBKpo'
    ),
    body    := '{}'::jsonb
  );
  $$
);
