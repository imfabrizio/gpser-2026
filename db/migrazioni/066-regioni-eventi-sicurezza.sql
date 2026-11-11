-- Più eventi attivi insieme: una gara in una regione non ne chiude un'altra, e lo stesso giorno possono esserci molti corsi
drop index if exists evento_unico_attivo;

-- Canovacci per regione: ogni regione vede e modifica i propri; quelli senza regione restano generali (storici ed esempi)
alter table canovaccio add column if not exists regione text;
update canovaccio c set regione = x.reg from (
  select distinct on (cv.id) cv.id, coalesce(e.regione,
           (select case when k.regione ilike 'trentino%' and k.provincia is not null then k.regione || ' · ' || k.provincia else k.regione end
              from comitato k where lower(k.nome) = lower(trim(e.comitato)) limit 1)) as reg
    from canovaccio cv join evento e on e.codice = cv.gara_codice or e.id in (select s.evento_id from scena s where s.canovaccio_id = cv.id)
   where coalesce(e.regione, (select k.regione from comitato k where lower(k.nome) = lower(trim(e.comitato)) limit 1)) is not null
   order by cv.id, (e.codice = cv.gara_codice) desc nulls last) x
 where x.id = c.id and c.regione is null;
drop index if exists canovaccio_gara_scena_versione_uq;
create unique index if not exists canovaccio_regione_gara_scena_versione_uq on canovaccio ((coalesce(regione, '')), (coalesce(gara_codice, '')), codice, versione);

-- Registrazione con password: l'indirizzo email va verificato con un codice (chi entra con Google o Microsoft è già verificato dal provider)
alter table richiesta_accesso add column if not exists email_verificata boolean not null default false;
alter table richiesta_accesso add column if not exists verifica_hash text;
alter table richiesta_accesso add column if not exists verifica_scade timestamptz;
update richiesta_accesso set email_verificata = true where provider <> 'password';

-- Sessioni: quelle nate prima di questo istante non valgono più (cambio password, reset). Codice OTP: un passo usato non si riusa
alter table utente add column if not exists sessioni_da timestamptz;
alter table utente add column if not exists mfa_ultimo_passo bigint;
