-- Proprietà del materiale (comitato / regione / nazionale), condivisione tra regioni, ruolo Approvatore
alter table evento add column if not exists data_fine date;                                                  -- ultimo giorno (gare su più giorni)
alter table evento add column if not exists livello text check (livello in ('comitato','regione','nazionale')); -- null = evento storico, visibile a tutto lo staff
alter table evento add column if not exists regione text;                                                    -- ente regionale proprietario (livello «regione»)
alter table patologia add column if not exists regione text;                                                 -- scheda del catalogo di una regione
alter table scena add column if not exists regione text;                                                     -- scena del catalogo di una regione
create table if not exists condivisione (
  tipo       text not null check (tipo in ('scena','patologia')),
  risorsa_id uuid not null,
  regione    text not null,                      -- ente regionale che può vederla
  comitati   boolean not null default false,     -- la regione la rende disponibile ai propri comitati
  origine    boolean not null default false,     -- riga della regione proprietaria
  created_at timestamptz not null default now(),
  primary key (tipo, risorsa_id, regione)
);
alter table promozione alter column scena_id drop not null;                                                 -- si può proporre anche una scheda della libreria (skill, Mega Code)
alter table promozione add column if not exists patologia_id uuid references patologia(id) on delete cascade;
alter table promozione add column if not exists regione text;                                                -- regione che deve decidere
alter table promozione add column if not exists comitato text;                                               -- comitato proponente
alter table promozione add column if not exists controllo jsonb;                                             -- confronto con il catalogo: identica / simile / nuova
insert into ruolo (codice, nome, sistema, aree) values ('approvatore', 'Approvatore', true, '{approvazione,scene,formazione_esame}') on conflict (codice) do nothing;
