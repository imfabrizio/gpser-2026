-- GareCRI – schema PostgreSQL 16
-- Principi:
--  * chiavi UUID generate anche dal client (pronto per l'offline)
--  * ogni riga modificabile ha updated_at (+ updated_by) per sync e audit
--  * la libreria (voci/patologie) è riusabile; la scena ne contiene una COPIA (snapshot):
--    modificare la libreria non altera mai le gare passate
--  * livello non consentito = punteggio NULL (sostituisce i flag Has_MB/Has_B/...)

create extension if not exists pgcrypto;

create type ruolo_utente as enum ('admin', 'organizzazione', 'giudice', 'giudice_master', 'partecipante');
create type livello      as enum ('MB', 'BE', 'SU', 'IN', 'NE');
create type stato_scheda as enum ('bozza', 'completata', 'verificata');
create type origine_dato as enum ('carta', 'tablet_online', 'tablet_offline');

-- ───────── utenti ─────────
create table ruolo (
  codice     text primary key,
  nome       text not null,
  sistema    boolean not null default false,
  aree       text[] not null default '{}',
  created_at timestamptz not null default now()
);
insert into ruolo (codice, nome, sistema, aree) values
  ('giudice', 'Giudice', true, '{valutazione}'),
  ('giudice_master', 'Giudice master', true, '{valutazione}'),
  ('partecipante', 'Partecipante e altri ruoli', true, '{}'),
  ('organizzazione', 'Organizzazione', true, '{gara,scene,schede,squadre,notizie,anagrafiche,classifiche,stampa,importa,segreteria,valutazione,documentazione,esami}'),
  ('segreteria', 'Segreteria', false, '{segreteria}'),
  ('istruttore', 'Istruttore', false, '{formazione_esame,esami}'),
  ('manovre_salvavita', 'Manovre salvavita', false, '{formazione_esame,esami}'),
  ('monitore', 'Monitore', false, '{formazione_esame,esami}');

create table utente (
  id            uuid primary key default gen_random_uuid(),
  tema          text check (tema in ('a', 'b', 'c')),          -- aspetto scelto dall'utente
  email         text not null unique,
  nome          text not null,
  password_hash text not null,
  ruolo         text not null default 'giudice' references ruolo(codice),
  admin         boolean not null default false,  -- amministratore: accesso a tutto, in aggiunta al ruolo
  attivo        boolean not null default true,
  evento_id     uuid,                            -- gara a cui l'utente è legato (FK aggiunta dopo la tabella evento)
  mfa_secret    text,                            -- segreto TOTP cifrato
  mfa_attiva    boolean not null default false,
  mfa_recupero  text[] not null default '{}',    -- hash dei codici di recupero
  ruolo_gara    text,                            -- ruolo in gara chiesto in registrazione (partecipante_leader, allenatore...)
  squadra_id    uuid,                            -- FK aggiunta dopo la tabella squadra
  cf_cifrato    text,                            -- codice fiscale cifrato
  comitato      text,
  provincia     text,
  created_at    timestamptz not null default now()
);

-- ───────── eventi (gare / olimpiadi) ─────────
create table formato_badge (
  id           uuid primary key default gen_random_uuid(),
  nome         text not null unique,
  larghezza_mm numeric(5,1) not null check (larghezza_mm between 30 and 300),
  altezza_mm   numeric(5,1) not null check (altezza_mm between 30 and 300),
  sistema      boolean not null default false,
  created_at   timestamptz not null default now()
);
insert into formato_badge (nome, larghezza_mm, altezza_mm, sistema) values ('10 × 7,5 cm', 100, 75, true), ('6 × 9 cm', 60, 90, true) ;

create table evento (
  id          uuid primary key default gen_random_uuid(),
  codice      text not null unique,              -- es. GPSER-2026
  nome        text not null,
  tipo        text not null default 'gara' check (tipo in ('gara','olimpiadi','allenamento','corso','esame','megacode')),
  soglia_pct  numeric(5,2) check (soglia_pct between 1 and 100),   -- percentuale minima per superare (esami)
  mostra_punteggi boolean not null default false,                   -- il giudice vede i punti e la percentuale mentre compila
  titolo_stampa text,                            -- "Gara Regionale di primo soccorso"
  luogo       text,
  data        date,
  attivo      boolean not null default false,
  archiviato  boolean not null default false,
  mappa_url   text,                              -- incorporamento di Google My Maps (facoltativo)
  formato_badge_id uuid references formato_badge(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index evento_unico_attivo on evento ((true)) where attivo;   -- un solo evento attivo
alter table utente add constraint utente_evento_fk foreign key (evento_id) references evento(id) on delete set null;

create table utente_identita (                   -- accesso con Google / Microsoft
  provider  text not null,
  sub       text not null,
  utente_id uuid not null references utente(id) on delete cascade,
  email     text,
  creata_at timestamptz not null default now(),
  primary key (provider, sub)
);

create table avviso (                            -- bacheca della Home
  id         uuid primary key default gen_random_uuid(),
  evento_id  uuid references evento(id) on delete cascade,   -- NULL = per tutti
  titolo     text not null,
  testo      text,
  pubblico   boolean not null default false,       -- visibile anche senza login
  created_at timestamptz not null default now()
);

create table squadra (
  id         uuid primary key default gen_random_uuid(),
  evento_id  uuid not null references evento(id) on delete cascade,
  numero     int  not null,                      -- il vecchio SquadraID, non si riusa mai
  nome       text not null,
  comitato   text,                               -- comitato con cui la squadra gareggia (i componenti possono venire da comitati diversi)
  attiva     boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (evento_id, numero)
);

-- ───────── anagrafica partecipanti (verifica requisiti, futura) ─────────
create table partecipante (
  id            uuid primary key default gen_random_uuid(),
  cognome       text not null,
  nome          text not null,
  data_nascita  date,
  codice_fiscale text unique,                    -- (non più usato: il codice fiscale è in cf_cifrato)
  utente_id     uuid unique references utente(id) on delete set null,
  cf_cifrato    text,
  cf_hash       text unique,
  ruolo_gara    text,
  email         text,
  comitato      text,
  provincia     text,
  note          text,
  created_at    timestamptz not null default now()
);
alter table utente add constraint utente_squadra_fk foreign key (squadra_id) references squadra(id) on delete set null;
create table squadra_membro (
  squadra_id      uuid not null references squadra(id) on delete cascade,
  partecipante_id uuid not null references partecipante(id),
  ruolo           text,                          -- capo squadra, soccorritore, riserva...
  primary key (squadra_id, partecipante_id)
);

-- ───────── segreteria: iscritti e arrivi ─────────
create table iscrizione (
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
create index iscrizione_evento_idx on iscrizione (evento_id);

-- ───────── libreria ─────────
-- scala di punteggio: un NULL significa "livello non consentito" (cella nera)
create table scala_punteggio (
  id      uuid primary key default gen_random_uuid(),
  codice  text not null unique,                  -- Standard, 3 Voci, PesoDoppio, Binario Punitivo
  mb int, be int, su int, "in" int, ne int,
  check (mb is not null or be is not null or su is not null or "in" is not null or ne is not null)
);

create table voce (                              -- "si guarda attorno (prima di entrare in scena)"
  id        uuid primary key default gen_random_uuid(),
  testo     text not null,
  note      text,
  created_at timestamptz not null default now()
);
create unique index voce_testo_uq on voce (lower(testo));

create table patologia (                         -- Master, PBLS, Overdose, TC, Asma...
  id           uuid primary key default gen_random_uuid(),
  codice       text not null unique,
  nome         text not null,
  sigla        text not null,                    -- MAS, PBL, OVE: usata nelle chiavi di stampa
  is_bls       boolean not null default false,   -- conta nella classifica BLS
  is_master    boolean not null default false,   -- conta nella classifica Master/Leader
  is_diu       boolean not null default false,   -- conta nella classifica DIU
  categoria    text,                             -- raggruppamento (es. Ictus)
  categoria2   text,                             -- seconda patologia (es. Frattura polso)
  fasce        jsonb,                            -- giudizi per punteggio, es. [{"da":0,"nome":"Insufficiente"},{"da":21,"nome":"Sufficiente"}]
  descrizione  text,
  comitato     text,                             -- null = libreria generale; altrimenti scheda privata del comitato
  creata_da    uuid references utente(id) on delete set null
);
create index patologia_comitato_idx on patologia (lower(comitato));
create table patologia_voce (
  patologia_id uuid not null references patologia(id) on delete cascade,
  ordine       int  not null,
  sezione      text not null,                    -- intestazione nera (AUTOPROTEZIONE e SICUREZZA...)
  voce_id      uuid not null references voce(id),
  scala_id     uuid not null references scala_punteggio(id),   -- override per patologia
  is_sep       boolean not null default false,
  primary key (patologia_id, ordine)
);

-- ───────── scene e schede di un evento (snapshot) ─────────
create table scena (
  id         uuid primary key default gen_random_uuid(),
  evento_id  uuid not null references evento(id) on delete restrict,
  codice     text not null,                      -- A, B, C...
  titolo     text not null,
  ordine     int  not null default 0,
  indirizzo  text,
  lat        numeric(9,6),
  lng        numeric(9,6),
  unique (evento_id, codice)
);

create table scena_scheda (                      -- una scheda = una patologia in una scena
  id               uuid primary key default gen_random_uuid(),
  scena_id         uuid not null references scena(id) on delete cascade,
  slot             int  not null,                -- 0 = Master, 1..n = simulatori
  patologia_id     uuid references patologia(id),-- origine (informativa)
  titolo           text not null,                -- "Master", "PBLS"...
  sigla            text not null,
  simulatore       text not null,                -- "M", "01", "02"...
  is_bls           boolean not null default false,
  is_master        boolean not null default false,
  is_diu           boolean not null default false,
  parametri        jsonb not null default '{}',  -- {coscienza, fr, fc, cute}
  fasce            jsonb,                        -- copia delle fasce di giudizio della patologia
  unique (scena_id, slot)
);

create table scena_scheda_voce (                 -- COPIA delle voci: modificabile per singola scena
  id            uuid primary key default gen_random_uuid(),
  scheda_id     uuid not null references scena_scheda(id) on delete cascade,
  ordine        int  not null,
  sezione       text not null,
  voce_id       uuid references voce(id),
  testo         text not null,
  scala         text not null,                   -- nome scala (informativo)
  mb int, be int, su int, "in" int, ne int,
  is_sep        boolean not null default false,
  unique (scheda_id, ordine),
  check (mb is not null or be is not null or su is not null or "in" is not null or ne is not null)
);

-- ───────── compilazione ─────────
create table compilazione (                      -- una scheda compilata per una squadra
  id          uuid primary key default gen_random_uuid(),
  scheda_id   uuid not null references scena_scheda(id) on delete restrict,   -- mai perdere valutazioni a cascata
  squadra_id  uuid not null references squadra(id) on delete restrict,
  stato       stato_scheda not null default 'bozza',
  origine     origine_dato not null default 'tablet_online',
  giudice     text,                              -- nome mostrato in stampa
  giudice_id  uuid references utente(id),
  iniziata_at timestamptz,
  completata_at timestamptz,
  verificata_at timestamptz,
  verificata_da uuid references utente(id),
  updated_at  timestamptz not null default now(),
  unique (scheda_id, squadra_id)                 -- impedisce le doppie compilazioni
);

create table risposta (                          -- una riga per voce compilata
  compilazione_id uuid not null references compilazione(id) on delete cascade,
  voce_id         uuid not null references scena_scheda_voce(id) on delete restrict,
  livello         livello,                              -- NULL = risposta annullata (tombstone: un dato vecchio non la fa risorgere)
  updated_at      timestamptz not null default now(),   -- decide i conflitti (vince il più recente)
  updated_by      uuid references utente(id),
  da_org          boolean not null default false,       -- scritta da organizzazione/admin: prevale sul giudice
  primary key (compilazione_id, voce_id)
);

-- ───────── audit ─────────
create table audit_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  utente_id uuid,
  azione    text not null,
  entita    text,
  entita_id text,
  dettaglio jsonb
);

-- ───────── viste punteggi ─────────
create view v_punti_voce as
select r.compilazione_id, r.voce_id, c.squadra_id, c.scheda_id, v.is_sep,
       case r.livello when 'MB' then v.mb when 'BE' then v.be when 'SU' then v.su
                      when 'IN' then v."in" when 'NE' then v.ne end as punti,
       coalesce(greatest(v.mb, v.be, v.su, v."in", v.ne), 0) as punti_max
from risposta r
join compilazione c on c.id = r.compilazione_id
join scena_scheda_voce v on v.id = r.voce_id
where r.livello is not null;

create view v_classifica as
select sq.evento_id, sq.id as squadra_id, sq.numero, sq.nome,
  coalesce(sum(p.punti),0)                                              as totale,
  coalesce(sum(p.punti) filter (where p.is_sep),0)                      as sep,
  coalesce(sum(p.punti) filter (where p.is_bls),0)                      as bls,
  coalesce(sum(p.punti) filter (where p.is_master),0)                   as master,
  coalesce(sum(p.punti) filter (where p.is_diu),0)                      as diu
from squadra sq
left join (
  -- solo schede dello STESSO evento della squadra
  select pv.squadra_id, pv.punti, pv.is_sep, s.is_bls, s.is_master, s.is_diu, sc.evento_id
  from v_punti_voce pv
  join scena_scheda s on s.id = pv.scheda_id
  join scena sc on sc.id = s.scena_id
) p on p.squadra_id = sq.id and p.evento_id = sq.evento_id
group by sq.evento_id, sq.id, sq.numero, sq.nome;

-- massimi teorici per la percentuale (corregge il bug di CONTROLLO!E21:F25)
create view v_massimi_evento as
select sc.evento_id,
  sum(greatest(v.mb, v.be, v.su, v."in", v.ne))                         as max_totale,
  sum(greatest(v.mb, v.be, v.su, v."in", v.ne)) filter (where v.is_sep) as max_sep
from scena sc
join scena_scheda s on s.scena_id = sc.id
join scena_scheda_voce v on v.scheda_id = s.id
group by sc.evento_id;

-- stato avanzamento (monitor)
create view v_monitor as
select sc.evento_id, sc.codice as scena, sq.numero as squadra, sq.nome,
       s.slot, s.titolo as scheda, c.stato, c.giudice, c.origine, c.updated_at,
       (select count(*) from risposta r where r.compilazione_id = c.id and r.livello is not null) as voci_compilate,
       (select count(*) from scena_scheda_voce v where v.scheda_id = s.id) as voci_totali
from scena sc
join scena_scheda s on s.scena_id = sc.id
join squadra sq on sq.evento_id = sc.evento_id and sq.attiva
left join compilazione c on c.scheda_id = s.id and c.squadra_id = sq.id;

-- ───────── assegnazione giudici alle schede (sostituisce tblOperatori) ─────────
create table assegnazione (
  scheda_id uuid not null references scena_scheda(id) on delete cascade,
  utente_id uuid not null references utente(id) on delete cascade,
  primary key (scheda_id, utente_id)
);

-- ───────── giudice master: comanda la scena (vede e corregge tutte le sue schede, chiude/verifica) ─────────
create table scena_master (
  scena_id  uuid not null references scena(id) on delete cascade,
  utente_id uuid not null references utente(id) on delete cascade,
  primary key (scena_id, utente_id)
);

-- ───────── risorse della gara: simulatori e truccatori per scena ─────────
create table if not exists scena_risorsa (
  scena_id     uuid not null references scena(id) on delete cascade,
  iscrizione_id uuid not null references iscrizione(id) on delete cascade,
  primary key (scena_id, iscrizione_id)
);
create index if not exists scena_risorsa_iscr_idx on scena_risorsa (iscrizione_id);

-- ───────── documentazione per gli utenti registrati (link) ─────────
create table documento (
  id          uuid primary key default gen_random_uuid(),
  categoria   text not null check (categoria in ('regolamento', 'comunicazioni', 'manuali', 'formazione', 'altro')),
  titolo      text not null check (length(titolo) between 1 and 150),
  descrizione text,
  url         text not null check (url ~ '^https://'),
  ordine      int  not null default 0,
  creato_da   uuid references utente(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ───────── versione dello schema ─────────
create table schema_migrazioni (nome text primary key, applicata_at timestamptz not null default now());
-- ───────── richieste di accesso (registrazione con approvazione) ─────────
create table richiesta_accesso (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null,
  sub           text not null,
  email         text not null,
  nome          text,
  cognome       text,
  cf_cifrato    text,
  cf_coerente   boolean,                      -- il codice corrisponde a nome e cognome? (avviso, non blocca)
  comitato      text,
  provincia     text,
  ruolo_gara    text,                         -- ruolo chiesto: partecipante_leader, giudice, allenatore...
  squadra_id    uuid references squadra(id) on delete set null,
  codice_ruolo  text,
  compilata     boolean not null default false,
  created_at    timestamptz not null default now(),
  scade_il      timestamptz not null default now() + interval '48 hours',
  unique (provider, sub)
);

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

insert into schema_migrazioni (nome) values ('001-revisione.sql'), ('002-giudice-master-ruolo.sql'), ('003-anagrafica-master.sql'), ('004-categorie-news-gara.sql'), ('005-pubblico-mappe.sql'), ('006-mfa-sso.sql'), ('007-richieste-accesso.sql'), ('008-ruoli-anagrafica.sql'), ('009-segreteria-badge.sql'), ('010-risorse-gara.sql'), ('011-esami-corsi.sql'), ('012-schede-comitato.sql'), ('013-aree-valutazione-documenti.sql'), ('014-tema.sql'), ('015-schede-esame-tssa.sql'), ('016-esami.sql'), ('017-megacode.sql'), ('018-comitati.sql');   -- lo schema qui sopra le include già tutte

-- schede d'esame TSSA (stesso contenuto della migrazione 015)
insert into scala_punteggio (codice, mb, su, ne) values ('Esame 0-1-2', 2, 1, 0) on conflict (codice) do nothing;

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-ptc', 'Skill 01 – PTC', 'PTC', 'Esame TSSA', 'Mod. SKILL 01 · TSSA/01. Errori gravi: non mantenere l''immobilizzazione manuale della testa; palpazione di addome e bacino; mancata sequenza ABCD. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 32, "nome": "Sufficiente"}, {"da": 36, "nome": "Discreto"}, {"da": 40, "nome": "Buono"}, {"da": 44, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Sicurezza') on conflict do nothing;
insert into voce (testo) values ('AVECA/AVCEA') on conflict do nothing;
insert into voce (testo) values ('Controllo emorragie') on conflict do nothing;
insert into voce (testo) values ('Blocca manualmente il capo (approccio frontale) e controlla la pervietà (dichiara l''eventuale spessore)') on conflict do nothing;
insert into voce (testo) values ('Fa porre il collare cervicale (prende la misura, controlla giugulari e trachea)') on conflict do nothing;
insert into voce (testo) values ('Ossigeno ad alti flussi 12/15 l con maschera reservoir') on conflict do nothing;
insert into voce (testo) values ('O = Osservazione espansione toracica') on conflict do nothing;
insert into voce (testo) values ('PA = Palpo e ascolto (crepitii, rumori respiratori)') on conflict do nothing;
insert into voce (testo) values ('C = Conto atti respiratori') on conflict do nothing;
insert into voce (testo) values ('S = Saturimetria e regolazione O2') on conflict do nothing;
insert into voce (testo) values ('Controllo fonti emorragiche, cute e segni di shock') on conflict do nothing;
insert into voce (testo) values ('Conto atti respiratori') on conflict do nothing;
insert into voce (testo) values ('Pressione') on conflict do nothing;
insert into voce (testo) values ('AVPU – Disabilità motoria (valida anche in E)') on conflict do nothing;
insert into voce (testo) values ('E: taglia e ricopre con metallina') on conflict do nothing;
insert into voce (testo) values ('Controllo testa (neurocranio e splancnocranio)') on conflict do nothing;
insert into voce (testo) values ('Controllo collo (eventuale disabilità motoria se non fatta in E)') on conflict do nothing;
insert into voce (testo) values ('Controllo torace (tattile)') on conflict do nothing;
insert into voce (testo) values ('Controllo addome e bacino (solo visivo)') on conflict do nothing;
insert into voce (testo) values ('Controllo gambe') on conflict do nothing;
insert into voce (testo) values ('Controllo braccia') on conflict do nothing;
insert into voce (testo) values ('AMPLE') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Sicurezza'),
  (2, 'AVECA/AVCEA'),
  (3, 'Controllo emorragie'),
  (4, 'Blocca manualmente il capo (approccio frontale) e controlla la pervietà (dichiara l''eventuale spessore)'),
  (5, 'Fa porre il collare cervicale (prende la misura, controlla giugulari e trachea)'),
  (6, 'Ossigeno ad alti flussi 12/15 l con maschera reservoir'),
  (7, 'O = Osservazione espansione toracica'),
  (8, 'PA = Palpo e ascolto (crepitii, rumori respiratori)'),
  (9, 'C = Conto atti respiratori'),
  (10, 'S = Saturimetria e regolazione O2'),
  (11, 'Controllo fonti emorragiche, cute e segni di shock'),
  (12, 'Conto atti respiratori'),
  (13, 'Pressione'),
  (14, 'AVPU – Disabilità motoria (valida anche in E)'),
  (15, 'E: taglia e ricopre con metallina'),
  (16, 'Controllo testa (neurocranio e splancnocranio)'),
  (17, 'Controllo collo (eventuale disabilità motoria se non fatta in E)'),
  (18, 'Controllo torace (tattile)'),
  (19, 'Controllo addome e bacino (solo visivo)'),
  (20, 'Controllo gambe'),
  (21, 'Controllo braccia'),
  (22, 'AMPLE')
) as t(n, testo)
where p.codice='esame-ptc' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-valutazione', 'Skill 04 – Valutazione', 'VAL', 'Esame TSSA', 'Mod. SKILL 04 · TS/01. Errori gravi: non mantenere l''immobilizzazione manuale della testa; palpazione di addome e bacino; mancata sequenza ABCD. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 21, "nome": "Sufficiente"}, {"da": 22, "nome": "Discreto"}, {"da": 23, "nome": "Buono"}, {"da": 24, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Sicurezza') on conflict do nothing;
insert into voce (testo) values ('Controllo pervietà e coscienza') on conflict do nothing;
insert into voce (testo) values ('O = Osservazione espansione toracica') on conflict do nothing;
insert into voce (testo) values ('PA = Palpo e ascolto (crepitii, rumori respiratori)') on conflict do nothing;
insert into voce (testo) values ('C = Conto atti respiratori') on conflict do nothing;
insert into voce (testo) values ('S = Saturimetria e regolazione O2') on conflict do nothing;
insert into voce (testo) values ('Conto frequenza cardiaca') on conflict do nothing;
insert into voce (testo) values ('Pressione') on conflict do nothing;
insert into voce (testo) values ('Controllo colore cute') on conflict do nothing;
insert into voce (testo) values ('AVPU – Disabilità motoria (valida anche in E)') on conflict do nothing;
insert into voce (testo) values ('Segni e sintomi') on conflict do nothing;
insert into voce (testo) values ('AMPLE') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Sicurezza'),
  (2, 'Controllo pervietà e coscienza'),
  (3, 'O = Osservazione espansione toracica'),
  (4, 'PA = Palpo e ascolto (crepitii, rumori respiratori)'),
  (5, 'C = Conto atti respiratori'),
  (6, 'S = Saturimetria e regolazione O2'),
  (7, 'Conto frequenza cardiaca'),
  (8, 'Pressione'),
  (9, 'Controllo colore cute'),
  (10, 'AVPU – Disabilità motoria (valida anche in E)'),
  (11, 'Segni e sintomi'),
  (12, 'AMPLE')
) as t(n, testo)
where p.codice='esame-valutazione' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-seggetta', 'Skill 03 – Seggetta', 'SEG', 'Esame TSSA', 'Mod. SKILL 3 · TS/02 (10/11/2024). Errori gravi: passare sopra al paziente; non assicurare il paziente al presidio; montaggio B-Lock dopo il posizionamento su barella. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 21, "nome": "Sufficiente"}, {"da": 24, "nome": "Discreto"}, {"da": 26, "nome": "Buono"}, {"da": 28, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Apre il presidio assicurando il corretto bloccaggio di tutte le componenti') on conflict do nothing;
insert into voce (testo) values ('Slaccia le cinture') on conflict do nothing;
insert into voce (testo) values ('Si assicura del corretto bloccaggio delle ruote') on conflict do nothing;
insert into voce (testo) values ('Posiziona il presidio in maniera sicura per la successiva movimentazione del paziente') on conflict do nothing;
insert into voce (testo) values ('Fa posizionare il secondo operatore alle gambe del paziente') on conflict do nothing;
insert into voce (testo) values ('Prende il paziente sotto le ascelle') on conflict do nothing;
insert into voce (testo) values ('Mantiene le braccia del paziente') on conflict do nothing;
insert into voce (testo) values ('Si coordina col secondo operatore per lo spostamento') on conflict do nothing;
insert into voce (testo) values ('Sposta il paziente sulla sedia') on conflict do nothing;
insert into voce (testo) values ('Allaccia le cinture della sedia') on conflict do nothing;
insert into voce (testo) values ('Garantisce la protezione termica') on conflict do nothing;
insert into voce (testo) values ('Verifica la giusta tensione della cintura toracica') on conflict do nothing;
insert into voce (testo) values ('Estrae le maniglie di trasporto') on conflict do nothing;
insert into voce (testo) values ('Movimenta correttamente il presidio (scale o terreno accidentato)') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Apre il presidio assicurando il corretto bloccaggio di tutte le componenti'),
  (2, 'Slaccia le cinture'),
  (3, 'Si assicura del corretto bloccaggio delle ruote'),
  (4, 'Posiziona il presidio in maniera sicura per la successiva movimentazione del paziente'),
  (5, 'Fa posizionare il secondo operatore alle gambe del paziente'),
  (6, 'Prende il paziente sotto le ascelle'),
  (7, 'Mantiene le braccia del paziente'),
  (8, 'Si coordina col secondo operatore per lo spostamento'),
  (9, 'Sposta il paziente sulla sedia'),
  (10, 'Allaccia le cinture della sedia'),
  (11, 'Garantisce la protezione termica'),
  (12, 'Verifica la giusta tensione della cintura toracica'),
  (13, 'Estrae le maniglie di trasporto'),
  (14, 'Movimenta correttamente il presidio (scale o terreno accidentato)')
) as t(n, testo)
where p.codice='esame-seggetta' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-scoop', 'Skill 15 – Barella Scoop EXL (trasporto)', 'SCO', 'Esame TSSA', 'Mod. SKILL 15 · TSSA/02 (10/11/2024). Errori gravi: passare sopra al paziente; non assicurare il paziente al presidio; montaggio B-Lock dopo il posizionamento su barella. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 21, "nome": "Sufficiente"}, {"da": 24, "nome": "Discreto"}, {"da": 26, "nome": "Buono"}, {"da": 28, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Posiziona correttamente la base fermacapo') on conflict do nothing;
insert into voce (testo) values ('Posiziona correttamente i coni laterali') on conflict do nothing;
insert into voce (testo) values ('Posiziona correttamente la base fermacapo (punto 3)') on conflict do nothing;
insert into voce (testo) values ('Pone la scoop a lato del paziente e prende correttamente la misura (riferimento collo/testa)') on conflict do nothing;
insert into voce (testo) values ('Apre la barella in sicurezza (lontano dal paziente)') on conflict do nothing;
insert into voce (testo) values ('Sposta una valva al lato opposto senza passare sopra al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona le due valve sotto al paziente senza sollevarlo') on conflict do nothing;
insert into voce (testo) values ('Verifica la corretta chiusura della barella alla testa e ai piedi') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente le cinture toraciche incrociate (1sx-3dx, 1sx-3dx o 1sx-2dx, 1sx-2dx)') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente la cintura alle gambe (3sx-3dx)') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente la cintura ai piedi (otto)') on conflict do nothing;
insert into voce (testo) values ('Ferma il blocco testa con cintura H') on conflict do nothing;
insert into voce (testo) values ('Afferra correttamente la barella e assume la posizione più idonea al sollevamento') on conflict do nothing;
insert into voce (testo) values ('Solleva la barella in modo sincrono con l''altro operatore') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Posiziona correttamente la base fermacapo'),
  (2, 'Posiziona correttamente i coni laterali'),
  (3, 'Posiziona correttamente la base fermacapo (punto 3)'),
  (4, 'Pone la scoop a lato del paziente e prende correttamente la misura (riferimento collo/testa)'),
  (5, 'Apre la barella in sicurezza (lontano dal paziente)'),
  (6, 'Sposta una valva al lato opposto senza passare sopra al paziente'),
  (7, 'Posiziona le due valve sotto al paziente senza sollevarlo'),
  (8, 'Verifica la corretta chiusura della barella alla testa e ai piedi'),
  (9, 'Applica correttamente le cinture toraciche incrociate (1sx-3dx, 1sx-3dx o 1sx-2dx, 1sx-2dx)'),
  (10, 'Applica correttamente la cintura alle gambe (3sx-3dx)'),
  (11, 'Applica correttamente la cintura ai piedi (otto)'),
  (12, 'Ferma il blocco testa con cintura H'),
  (13, 'Afferra correttamente la barella e assume la posizione più idonea al sollevamento'),
  (14, 'Solleva la barella in modo sincrono con l''altro operatore')
) as t(n, testo)
where p.codice='esame-scoop' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
