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
  ('giudice', 'Giudice', true, '{}'),
  ('giudice_master', 'Giudice master', true, '{}'),
  ('partecipante', 'Partecipante e altri ruoli', true, '{}'),
  ('organizzazione', 'Organizzazione', true, '{gara,scene,schede,squadre,notizie,anagrafiche,classifiche,stampa,importa,segreteria}'),
  ('segreteria', 'Segreteria', false, '{segreteria}'),
  ('istruttore', 'Istruttore', false, '{schede_comitato}'),
  ('manovre_salvavita', 'Manovre salvavita', false, '{schede_comitato}'),
  ('monitore', 'Monitore', false, '{schede_comitato}');

create table utente (
  id            uuid primary key default gen_random_uuid(),
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
  tipo        text not null default 'gara' check (tipo in ('gara','olimpiadi','allenamento','corso','esame')),
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

insert into schema_migrazioni (nome) values ('001-revisione.sql'), ('002-giudice-master-ruolo.sql'), ('003-anagrafica-master.sql'), ('004-categorie-news-gara.sql'), ('005-pubblico-mappe.sql'), ('006-mfa-sso.sql'), ('007-richieste-accesso.sql'), ('008-ruoli-anagrafica.sql'), ('009-segreteria-badge.sql'), ('010-risorse-gara.sql'), ('011-esami-corsi.sql'), ('012-schede-comitato.sql');   -- lo schema qui sopra le include già tutte
