-- Gara offline: scene senza copertura, codici temporanei dei giudici, elenco dei dispositivi
alter table scena add column if not exists offline boolean not null default false;

-- codice temporaneo di un giudice (o master) per una gara: salvato cifrato (si può ristampare il foglietto), mai in chiaro
create table if not exists offline_codice (
  evento_id  uuid not null references evento(id) on delete cascade,
  utente_id  uuid not null references utente(id) on delete cascade,
  codice_cifrato text not null,
  created_at timestamptz not null default now(),
  primary key (evento_id, utente_id)
);

-- browser/tablet/telefoni che hanno usato il sito; l'identificativo lo genera il dispositivo la prima volta
create table if not exists dispositivo (
  id          uuid primary key,
  nome        text,
  tipo        text not null default 'computer' check (tipo in ('telefono','tablet','computer')),
  sistema     text,
  ultimo_utente uuid references utente(id) on delete set null,
  visto_il    timestamptz not null default now(),
  creato_il   timestamptz not null default now(),
  modalita    text not null default 'online' check (modalita in ('online','offline')),
  evento_id   uuid references evento(id) on delete set null,
  preparato_il timestamptz,
  ultima_sync timestamptz
);
