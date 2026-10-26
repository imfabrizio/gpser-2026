-- svolgimento della gara: online (tablet, il giudice master apre e chiude la scena per squadra) o cartacea (schede inserite in differita);
-- rotazione: scena di partenza di ogni squadra; turni: la squadra su una scena, aperta e chiusa dal giudice master
alter table evento add column if not exists modalita text not null default 'cartacea' check (modalita in ('online','cartacea'));
alter table squadra add column if not exists partenza_scena_id uuid references scena(id) on delete set null;
create table if not exists scena_turno (
  scena_id    uuid not null references scena(id) on delete cascade,
  squadra_id  uuid not null references squadra(id) on delete cascade,
  stato       text not null default 'aperta' check (stato in ('attesa','aperta','chiusa')),
  attesa_at   timestamptz,
  aperta_at   timestamptz,
  chiusa_at   timestamptz,
  aperta_da   uuid references utente(id) on delete set null,
  chiusa_da   uuid references utente(id) on delete set null,
  primary key (scena_id, squadra_id)
);
create unique index if not exists scena_turno_una_aperta_scena on scena_turno (scena_id) where stato = 'aperta';
create unique index if not exists scena_turno_una_aperta_squadra on scena_turno (squadra_id) where stato = 'aperta';
