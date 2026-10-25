-- Promozione di scene e schede dagli allenamenti (e dalle gare) alla libreria regionale o nazionale
alter table patologia add column if not exists livello text check (livello in ('regionale','nazionale'));   -- null = libreria generale storica
alter table scena     add column if not exists condivisa text check (condivisa in ('regionale','nazionale')); -- scena disponibile a tutti come modello
create table if not exists promozione (
  id            uuid primary key default gen_random_uuid(),
  scena_id      uuid not null references scena(id) on delete cascade,
  tipo          text not null check (tipo in ('scena','schede')),            -- tutta la scena oppure solo le schede
  livello       text not null check (livello in ('regionale','nazionale')),
  stato         text not null default 'in_attesa' check (stato in ('in_attesa','approvata','rifiutata')),
  automatica    boolean not null default false,                               -- proposta da chi può approvare: promossa subito
  proposta_da   uuid references utente(id) on delete set null,
  nota          text,
  deciso_da     uuid references utente(id) on delete set null,
  deciso_il     timestamptz,
  motivo        text,                                                         -- motivo del rifiuto
  esito         jsonb,                                                        -- schede pubblicate / create
  created_at    timestamptz not null default now()
);
create index if not exists promozione_stato_idx on promozione (stato, created_at);
