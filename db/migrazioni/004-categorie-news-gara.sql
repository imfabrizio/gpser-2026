-- patologie raggruppate per categoria (con eventuale seconda categoria), classifica DIU,
-- utente legato a una gara, bacheca di avvisi
alter table patologia add column if not exists categoria text;
alter table patologia add column if not exists categoria2 text;
alter table patologia add column if not exists is_diu boolean not null default false;
alter table scena_scheda add column if not exists is_diu boolean not null default false;
update patologia set categoria = trim(split_part(nome, ' · ', 1)) where categoria is null;
alter table utente add column if not exists evento_id uuid references evento(id) on delete set null;
create table if not exists avviso (
  id         uuid primary key default gen_random_uuid(),
  evento_id  uuid references evento(id) on delete cascade,   -- NULL = per tutti
  titolo     text not null,
  testo      text,
  created_at timestamptz not null default now()
);
drop view if exists v_classifica;
create view v_classifica as
select sq.evento_id, sq.id as squadra_id, sq.numero, sq.nome,
  coalesce(sum(p.punti),0)                                              as totale,
  coalesce(sum(p.punti) filter (where p.is_sep),0)                      as sep,
  coalesce(sum(p.punti) filter (where p.is_bls),0)                      as bls,
  coalesce(sum(p.punti) filter (where p.is_master),0)                   as master,
  coalesce(sum(p.punti) filter (where p.is_diu),0)                      as diu
from squadra sq
left join (
  select pv.squadra_id, pv.punti, pv.is_sep, s.is_bls, s.is_master, s.is_diu, sc.evento_id
  from v_punti_voce pv
  join scena_scheda s on s.id = pv.scheda_id
  join scena sc on sc.id = s.scena_id
) p on p.squadra_id = sq.id and p.evento_id = sq.evento_id
group by sq.evento_id, sq.id, sq.numero, sq.nome;
