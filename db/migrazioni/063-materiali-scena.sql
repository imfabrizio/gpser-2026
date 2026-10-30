-- Materiali necessari: per ogni scena (e generici di gara, es. gazebo dell'attesa). La logistica li vede e segna quelli pronti
create table if not exists scena_materiale (
  id         uuid primary key default gen_random_uuid(),
  evento_id  uuid not null references evento(id) on delete cascade,
  scena_id   uuid references scena(id) on delete cascade,   -- vuoto = materiale generico della gara
  nome       text not null,
  quantita   int  not null default 1 check (quantita > 0),
  nota       text,
  pronto     boolean not null default false,
  ordine     int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists scena_materiale_evento_idx on scena_materiale (evento_id, scena_id);
