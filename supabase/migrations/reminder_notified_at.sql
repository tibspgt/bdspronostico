-- Marque le moment où le rappel « coup d'envoi dans 1h » a été envoyé pour un
-- match, afin de ne l'envoyer qu'une seule fois.
alter table matches
  add column if not exists reminder_notified_at timestamptz;
