-- Ruoli personalizzabili con permessi per area, admin come spunta in più, anagrafica collegata agli utenti.
create table if not exists ruolo (
  codice     text primary key,
  nome       text not null,
  sistema    boolean not null default false,          -- ruoli di base: non eliminabili
  aree       text[] not null default '{}',            -- aree di Gestione consentite (vuoto = nessun accesso alla Gestione)
  created_at timestamptz not null default now()
);
insert into ruolo (codice, nome, sistema, aree) values
  ('giudice', 'Giudice', true, '{}'),
  ('giudice_master', 'Giudice master', true, '{}'),
  ('partecipante', 'Partecipante e altri ruoli', true, '{}'),
  ('organizzazione', 'Organizzazione', true, '{gara,scene,schede,squadre,notizie,anagrafiche,classifiche,stampa,importa}')
on conflict (codice) do nothing;
alter table utente alter column ruolo drop default;
alter table utente alter column ruolo type text using ruolo::text;
alter table utente add column if not exists admin boolean not null default false;
update utente set admin = true, ruolo = 'organizzazione' where ruolo = 'admin';
alter table utente alter column ruolo set default 'giudice';
alter table utente add constraint utente_ruolo_fk foreign key (ruolo) references ruolo(codice);
-- anagrafica: ogni utente ha una persona; il codice fiscale è cifrato (hash per ricerca e unicità)
alter table partecipante add column if not exists utente_id  uuid unique references utente(id) on delete set null;
alter table partecipante add column if not exists cf_cifrato text;
alter table partecipante add column if not exists cf_hash    text unique;
alter table partecipante add column if not exists ruolo_gara text;
update partecipante p set utente_id = x.id from (select distinct on (lower(email)) id, lower(email) as em from utente order by lower(email), created_at) x
 where p.utente_id is null and p.email is not null and lower(p.email) = x.em and not exists (select 1 from partecipante q where q.utente_id = x.id);
insert into partecipante (cognome, nome, email, utente_id)
select coalesce(nullif(regexp_replace(trim(u.nome), '^.*\s', ''), ''), u.email),
       coalesce(nullif(regexp_replace(trim(u.nome), '\s+\S+$', ''), ''), u.nome), u.email, u.id
  from utente u where not exists (select 1 from partecipante p where p.utente_id = u.id);
