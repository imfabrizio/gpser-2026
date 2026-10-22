-- Risorse della gara: simulatori e truccatori assegnati alle scene (i giudici restano in `assegnazione`)
create table if not exists scena_risorsa (
  scena_id     uuid not null references scena(id) on delete cascade,
  iscrizione_id uuid not null references iscrizione(id) on delete cascade,
  primary key (scena_id, iscrizione_id)
);
create index if not exists scena_risorsa_iscr_idx on scena_risorsa (iscrizione_id);
