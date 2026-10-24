-- Corsi: comitato organizzatore (ambito locale dei trainer) e inviti di trainer di altri comitati al singolo evento.
alter table evento add column if not exists comitato text;
create table if not exists evento_invito (
  evento_id   uuid not null references evento(id) on delete cascade,
  utente_id   uuid not null references utente(id) on delete cascade,
  invitato_da uuid references utente(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (evento_id, utente_id)
);
