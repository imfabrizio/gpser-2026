-- L'ambito sta sul tipo di corso, non sulla persona.
--   regionale: chi ha la qualifica apre il corso nel proprio comitato; per un altro comitato della sua regione serve la delega
--              approvata dalla formazione regionale. Fuori regione non si opera.
--   nazionale: si apre per qualunque comitato (primo soccorso, DU, corsi che formano i trainer).
alter table tipo_corso add column if not exists ambito text not null default 'regionale';
alter table tipo_corso drop constraint if exists tipo_corso_ambito_check;
alter table tipo_corso add constraint tipo_corso_ambito_check check (ambito in ('regionale','nazionale'));
update tipo_corso set ambito = 'nazionale' where codice in ('ps', 'du');
-- i corsi che formano i trainer li tengono i formatori (che, essendo anche trainer, restano tra i docenti dei corsi per operatori)
insert into tipo_corso (codice, nome, docenti, valutatori, ordine, ambito) values
  ('ttssa', 'TTSSA (corso per trainer TSSA)', '{formatore_tssa}', '{formatore_tssa}', 5, 'nazionale'),
  ('tms',   'Corso per trainer MS',           '{formatore_ms}',   '{formatore_ms}',   6, 'nazionale')
on conflict (codice) do nothing;

-- sulle qualifiche resta solo l'indicazione «di formazione» (serve a sapere chi può insegnare): locale / regionale / nazionale non contano più
alter table qualifica drop constraint if exists qualifica_ambito_check;
update qualifica set ambito = 'formazione' where ambito is not null;
alter table qualifica add constraint qualifica_ambito_check check (ambito in ('formazione','locale','regionale','nazionale'));   -- i valori vecchi restano ammessi solo perché le migrazioni precedenti si possano rieseguire

-- direttore del corso: chi lo apre; può passare l'incarico a un altro docente del corso
alter table evento add column if not exists direttore_id uuid references utente(id) on delete set null;
update evento e set direttore_id = (select i.utente_id from evento_invito i where i.evento_id = e.id and i.stato = 'attivo' and i.invitato_da = i.utente_id order by i.created_at limit 1)
 where e.tipo = 'corso' and e.direttore_id is null;

-- delega: richiesta di aprire un corso per un altro comitato della propria regione; alla approvazione il corso nasce con i dati salvati qui
create table if not exists delega_corso (
  id          uuid primary key default gen_random_uuid(),
  richiedente uuid not null references utente(id) on delete cascade,
  comitato    text not null,
  regione     text,
  tipo_corso  text not null references tipo_corso(codice),
  dati        jsonb not null,
  stato       text not null default 'richiesta' check (stato in ('richiesta','approvata','rifiutata')),
  nota        text,
  deciso_da   uuid references utente(id) on delete set null,
  deciso_il   timestamptz,
  evento_id   uuid references evento(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists delega_corso_stato_idx on delega_corso (stato, regione);
