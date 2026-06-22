-- Planifie l'appel automatique de la fonction "match-reminders" toutes les
-- 10 minutes. Elle décide elle-même quels matchs sont à ~1h du coup d'envoi.
--
-- Nécessite les extensions pg_cron et pg_net (Database → Extensions, ou ci-dessous).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Supprime l'ancienne planification si elle existe (rend ce script ré-exécutable)
select cron.unschedule(jobid) from cron.job where jobname = 'match-reminders';

-- Toutes les 10 minutes
select cron.schedule(
  'match-reminders',
  '*/10 * * * *',
  $$
  select net.http_post(
    url     := 'https://godcigantcuuwnwerxjc.supabase.co/functions/v1/match-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvZGNpZ2FudGN1dXdud2VyeGpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNjU5MzYsImV4cCI6MjA5MTc0MTkzNn0.6udFhN0OhzWOGhLoLrD3q2qoS9zey9iHQVCUsdkBKpo'
    ),
    body    := '{}'::jsonb
  );
  $$
);
