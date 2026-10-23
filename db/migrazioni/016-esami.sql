-- Area «Esami»: sessioni d'esame, prove con candidato principale e fino a due secondari. Niente squadre né scene.
update ruolo set aree = array_append(aree, 'esami') where codice in ('organizzazione', 'istruttore', 'manovre_salvavita', 'monitore') and not ('esami' = any(aree));
create table if not exists sessione_esame (
  id         uuid primary key default gen_random_uuid(),
  nome       text not null check (length(nome) between 1 and 150),
  data       date,
  luogo      text,
  creato_da  uuid references utente(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists prova_esame (
  id           uuid primary key default gen_random_uuid(),
  sessione_id  uuid not null references sessione_esame(id) on delete cascade,
  patologia_id uuid references patologia(id) on delete set null,
  titolo       text not null,
  fasce        jsonb,
  voci         jsonb not null,                  -- copia della scheda: [{ordine, sezione, testo, ne, su, mb}]
  valutatore   text,
  stato        text not null default 'bozza' check (stato in ('bozza', 'chiusa')),
  errore_grave boolean not null default false,  -- vale per tutti i candidati, salvo diversa indicazione sul candidato
  chiusa_at    timestamptz,
  ordine       int not null default 0,
  created_at   timestamptz not null default now()
);
create table if not exists candidato_esame (
  id              uuid primary key default gen_random_uuid(),
  prova_id        uuid not null references prova_esame(id) on delete cascade,
  ruolo           text not null check (ruolo in ('principale', 'secondario')),
  nome            text not null,
  comitato        text,
  partecipante_id uuid references partecipante(id) on delete set null,
  errore_grave    boolean,                      -- null = segue la prova
  ordine          int not null default 0
);
create table if not exists risposta_esame (      -- candidato_id null = valutazione comune a tutti; con candidato = valore diverso solo per lui
  prova_id     uuid not null references prova_esame(id) on delete cascade,
  candidato_id uuid references candidato_esame(id) on delete cascade,
  ordine       int not null,
  livello      text not null check (livello in ('NE', 'SU', 'MB'))
);
create unique index if not exists risposta_esame_uq on risposta_esame (prova_id, coalesce(candidato_id, '00000000-0000-0000-0000-000000000000'::uuid), ordine);
