-- Canovacci: descrizione completa di una scena (briefing, pazienti, triage, logistica) in versione Gara oppure Olimpiadi
create table if not exists canovaccio (
  id         uuid primary key default gen_random_uuid(),
  codice     text not null,                                   -- lettera della scena: A, B, C...
  versione   text not null check (versione in ('gara','olimpiadi')),
  titolo     text not null,
  tempo_min  int,
  dati       jsonb not null default '{}'::jsonb,              -- sezioni, triage, pazienti, logistica
  fabbisogno jsonb not null default '{}'::jsonb,              -- simulatori, manichini, attori, trucchi (calcolato)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (codice, versione)
);
alter table scena add column if not exists canovaccio_id uuid references canovaccio(id) on delete set null;
