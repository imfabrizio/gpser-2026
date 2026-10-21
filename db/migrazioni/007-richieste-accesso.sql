-- Richieste di accesso: chi entra con Google/Microsoft senza essere registrato compila un modulo e attende l'approvazione.
alter type ruolo_utente add value if not exists 'partecipante';      -- nessun potere: vede solo home e notizie
alter table utente add column if not exists ruolo_gara  text;        -- partecipante_leader, allenatore, fotografo...
alter table utente add column if not exists squadra_id  uuid references squadra(id) on delete set null;
alter table utente add column if not exists cf_cifrato  text;        -- codice fiscale cifrato (AES-256-GCM)
alter table utente add column if not exists comitato    text;
alter table utente add column if not exists provincia   text;
create table if not exists richiesta_accesso (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  sub           text not null,
  email         text not null,
  nome          text,
  cognome       text,
  cf_cifrato    text,
  cf_coerente   boolean,                      -- il codice corrisponde a nome e cognome? (avviso, non blocca)
  comitato      text,
  provincia     text,
  ruolo_gara    text,                         -- ruolo chiesto: partecipante_leader, giudice, allenatore...
  squadra_id    uuid references squadra(id) on delete set null,
  codice_ruolo  text,
  compilata     boolean not null default false,
  created_at    timestamptz not null default now(),
  scade_il      timestamptz not null default now() + interval '48 hours',
  unique (provider, sub)
);
