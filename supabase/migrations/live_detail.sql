-- Détail "live" affiché pendant un match (ex. "Mi-temps", "67'", "90'+2'").
-- Renseigné par sync-espn-live tant que le match est en cours, remis à NULL
-- une fois terminé. N'affecte pas matches.status (qui reste
-- upcoming / live / finished).
alter table matches
  add column if not exists live_detail text;
