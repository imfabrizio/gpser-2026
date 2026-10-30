-- Materiali: oltre a "pronto" (preparato) si segnano caricato, montato in scena e ritirato a fine gara
alter table scena_materiale add column if not exists caricato boolean not null default false;
alter table scena_materiale add column if not exists montato  boolean not null default false;
alter table scena_materiale add column if not exists ritirato boolean not null default false;
