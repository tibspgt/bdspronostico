-- Cache de l'identifiant d'événement ESPN pour chaque match.
-- Résolu une seule fois (via le scoreboard ESPN), puis réutilisé à chaque
-- synchro live. Modifiable à la main si un match n'est pas reconnu.
alter table matches
  add column if not exists espn_event_id text;
