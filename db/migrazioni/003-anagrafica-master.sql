-- anagrafica: provincia della persona e comitato della squadra; giudice master assegnato alla scena
alter table partecipante add column if not exists provincia text;
alter table squadra add column if not exists comitato text;
create table if not exists scena_master (
  scena_id  uuid not null references scena(id) on delete cascade,
  utente_id uuid not null references utente(id) on delete cascade,
  primary key (scena_id, utente_id)
);
