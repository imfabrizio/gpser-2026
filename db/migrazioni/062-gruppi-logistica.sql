-- Gruppi di ruoli (trasversali): un gruppo raccoglie più ruoli, chi è nel gruppo li ha tutti. Logistica: ruolo per singola gara
create table if not exists gruppo (
  codice text primary key,
  nome   text not null,
  created_at timestamptz not null default now()
);
create table if not exists gruppo_ruolo (
  gruppo text not null references gruppo(codice) on delete cascade,
  ruolo  text not null references ruolo(codice) on delete cascade,
  primary key (gruppo, ruolo)
);
create table if not exists utente_gruppo (
  utente_id uuid not null references utente(id) on delete cascade,
  gruppo    text not null references gruppo(codice) on delete cascade,
  primary key (utente_id, gruppo)
);
create table if not exists evento_logistica (
  evento_id uuid not null references evento(id) on delete cascade,
  utente_id uuid not null references utente(id) on delete cascade,
  aggiunto_da uuid references utente(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (evento_id, utente_id)
);
