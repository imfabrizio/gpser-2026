-- Registro dei backup (database e sito): quando, di che tipo, dove è finito
create table if not exists backup_log (
  id         uuid primary key default gen_random_uuid(),
  creato_il  timestamptz not null default now(),
  tipo       text not null check (tipo in ('automatico','manuale')),
  ok         boolean not null,
  nome       text,
  dimensione bigint,
  destinazione text,              -- github / solo scaricato
  errore     text,
  eseguito_da uuid references utente(id) on delete set null
);
create index if not exists backup_log_data_idx on backup_log (creato_il desc);
