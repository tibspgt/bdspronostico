-- Marque le moment où le rappel « ajoute l'homme du match » a été envoyé aux
-- admins pour un match terminé, afin de ne l'envoyer qu'une seule fois.
alter table matches
  add column if not exists motm_notified_at timestamptz;
