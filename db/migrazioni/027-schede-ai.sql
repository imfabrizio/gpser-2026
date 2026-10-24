-- Schede generate con l'AI: sempre bozze, visibili solo a chi le ha generate finché non vengono pubblicate. Chiavi AI personali cifrate.
alter table patologia add column if not exists bozza boolean not null default false;
alter table patologia add column if not exists generata_ai text;          -- provider usato (gemini, anthropic, openai)
create table if not exists utente_chiave_ai (
  utente_id uuid not null references utente(id) on delete cascade,
  provider  text not null check (provider in ('gemini','anthropic','openai')),
  chiave_cifrata text not null,
  created_at timestamptz not null default now(),
  primary key (utente_id, provider)
);
