-- Preferenze personali: widget della Home scelti dall'utente e contatti preferiti
alter table utente add column if not exists preferenze jsonb not null default '{}'::jsonb;
