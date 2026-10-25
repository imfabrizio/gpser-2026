-- notifiche per utente (richieste di accesso, proposte alla regione, esiti)
create table if not exists notifica (
  id         uuid primary key default gen_random_uuid(),
  utente_id  uuid not null references utente(id) on delete cascade,
  tipo       text not null,
  titolo     text not null,
  testo      text,
  link       text,
  letta      boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifica_utente_idx on notifica (utente_id, letta, created_at desc);
