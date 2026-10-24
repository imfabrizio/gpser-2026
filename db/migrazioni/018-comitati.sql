-- Elenco dei comitati CRI con le loro unità territoriali; le scritture libere si riconducono al nome ufficiale
create table if not exists comitato (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null check (length(nome) between 1 and 120),
  regione    text,
  provincia  text,
  alias      text[] not null default '{}',     -- altri modi di scriverlo (Prignano SS, Prignano s.S., …)
  created_at timestamptz not null default now()
);
create unique index if not exists comitato_nome_uq on comitato (lower(nome));
create table if not exists unita_territoriale (
  id          uuid primary key default gen_random_uuid(),
  comitato_id uuid not null references comitato(id) on delete cascade,
  nome        text not null check (length(nome) between 1 and 120)
);
create unique index if not exists unita_uq on unita_territoriale (comitato_id, lower(nome));
alter table partecipante add column if not exists unita text;
