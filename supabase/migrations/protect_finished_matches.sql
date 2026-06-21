-- Empêche la synchro automatique des scores (clé service_role, exécutée par
-- l'edge function toutes les 5 min) de "déverrouiller" un match déjà terminé
-- ou d'écraser le score saisi à la main par l'admin.
--
-- Pourquoi : l'app se connecte avec le rôle `anon` (login prénom + PIN, pas
-- d'auth Supabase), tandis que l'edge function de synchro utilise le rôle
-- `service_role`. On peut donc bloquer uniquement la synchro automatique,
-- tout en laissant l'admin rouvrir un match manuellement ("🔓 Rouvrir").

create or replace function protect_finished_matches()
returns trigger
language plpgsql
as $$
begin
  if current_user = 'service_role' and old.status = 'finished' then
    -- On gèle le statut et le score d'un match terminé face à la synchro auto.
    new.status     := old.status;
    new.score_home := old.score_home;
    new.score_away := old.score_away;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_finished_matches on matches;
create trigger trg_protect_finished_matches
  before update on matches
  for each row
  execute function protect_finished_matches();
