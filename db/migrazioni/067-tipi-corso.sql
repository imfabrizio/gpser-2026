-- Tipi di corso: quali qualifiche possono aprire un corso di quel tipo e insegnarvi (docenti) e quali possono valutare (valutatori).
-- La regola sta nei dati: un nuovo tipo di corso si aggiunge qui (dalla Gestione), senza toccare il codice.
create table if not exists tipo_corso (
  codice     text primary key,
  nome       text not null check (length(nome) between 1 and 60),
  docenti    text[] not null default '{}',
  valutatori text[] not null default '{}',
  ordine     int not null default 0,
  created_at timestamptz not null default now()
);
insert into tipo_corso (codice, nome, docenti, valutatori, ordine) values
  ('tssa', 'TSSA',              '{trainer_tssa,formatore_tssa}', '{trainer_tssa,formatore_tssa}', 1),
  ('ms',   'Manovre salvavita', '{trainer_ms,formatore_ms}',     '{trainer_ms,formatore_ms}',     2),
  ('ps',   'Primo soccorso',    '{monitore,capo_monitore}',      '{monitore,capo_monitore}',      3),
  ('du',   'Istruttore DU',     '{istruttore_du}',               '{istruttore_du}',               4)
on conflict (codice) do nothing;
-- il tipo sta sul corso (o sull'esame che non appartiene a un corso); Mega Code ed esami di un corso seguono il corso
alter table evento add column if not exists tipo_corso text references tipo_corso(codice);
update evento set tipo_corso = 'tssa' where tipo in ('corso','esame','megacode') and corso_id is null and tipo_corso is null;   -- finora il sito è stato usato per il TSSA
