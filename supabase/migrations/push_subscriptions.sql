create table if not exists push_subscriptions (
  id         uuid default gen_random_uuid() primary key,
  player_id  uuid references players(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz default now(),
  unique(player_id)
);

-- Permet à l'app (rôle anon) de lire/écrire ses propres abonnements
alter table push_subscriptions enable row level security;

create policy "insert own subscription"
  on push_subscriptions for insert
  with check (true);

create policy "update own subscription"
  on push_subscriptions for update
  using (true);
