-- Direzione gara: le persone (3-4) che per una gara possono riaprire le schede chiuse e compilare al posto dei giudici
create table if not exists evento_direzione (
  evento_id  uuid not null references evento(id) on delete cascade,
  utente_id  uuid not null references utente(id) on delete cascade,
  aggiunto_da uuid references utente(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (evento_id, utente_id)
);
