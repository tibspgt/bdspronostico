-- Marque le moment où la notification « Les scores sont tombés ! » a été
-- envoyée pour un match, afin de ne l'envoyer qu'une seule fois.
alter table matches
  add column if not exists scores_notified_at timestamptz;
