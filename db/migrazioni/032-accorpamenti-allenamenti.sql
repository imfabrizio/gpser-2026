-- Doppioni in libreria (coppie da non riproporre) e comitati invitati agli allenamenti
create table if not exists accorpamento_ignorato (
  a          uuid not null references patologia(id) on delete cascade,
  b          uuid not null references patologia(id) on delete cascade,
  deciso_da  uuid references utente(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);
create table if not exists evento_comitato_invitato (
  evento_id   uuid not null references evento(id) on delete cascade,
  comitato    text not null,                       -- nome ufficiale del comitato invitato
  invitato_da uuid references utente(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (evento_id, comitato)
);
update ruolo set aree = (select array(select distinct unnest(aree || '{gara,squadre,classifiche,stampa}'::text[]))) where codice = 'approvatore';
