-- Segreteria: iscritti per gara con registrazione dell'arrivo, formati dei badge.
create table if not exists formato_badge (
  id           uuid primary key default gen_random_uuid(),
  nome         text not null unique,
  larghezza_mm numeric(5,1) not null check (larghezza_mm between 30 and 300),
  altezza_mm   numeric(5,1) not null check (altezza_mm between 30 and 300),
  sistema      boolean not null default false,
  created_at   timestamptz not null default now()
);
insert into formato_badge (nome, larghezza_mm, altezza_mm, sistema) values ('10 × 7,5 cm', 100, 75, true), ('6 × 9 cm', 60, 90, true) on conflict (nome) do nothing;
alter table evento add column if not exists formato_badge_id uuid references formato_badge(id) on delete set null;
create table if not exists iscrizione (
  id              uuid primary key default gen_random_uuid(),
  evento_id       uuid not null references evento(id) on delete cascade,
  partecipante_id uuid not null references partecipante(id),
  ruolo           text not null default 'partecipante_membro',   -- ruolo in gara (capo squadra, soccorritore, giudice, simulatore...)
  squadra_id      uuid references squadra(id) on delete set null,
  arrivato_at     timestamptz,
  arrivato_da     uuid references utente(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (evento_id, partecipante_id)
);
create index if not exists iscrizione_evento_idx on iscrizione (evento_id);
insert into ruolo (codice, nome, sistema, aree) values ('segreteria', 'Segreteria', false, '{segreteria}') on conflict (codice) do nothing;
update ruolo set aree = array_append(aree, 'segreteria') where codice = 'organizzazione' and not ('segreteria' = any(aree));
