-- 001: correzioni emerse dalla revisione indipendente. Idempotente: si può rilanciare senza danni.

-- un solo evento attivo (se ce ne sono più di uno resta il più recente)
update evento set attivo = false where attivo and id <> (select id from evento where attivo order by updated_at desc, created_at desc limit 1);
create unique index if not exists evento_unico_attivo on evento ((true)) where attivo;

-- almeno un livello selezionabile per ogni voce di scena
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'scena_scheda_voce'::regclass and contype = 'c') then
    alter table scena_scheda_voce add check (mb is not null or be is not null or su is not null or "in" is not null or ne is not null);
  end if;
end $$;

-- mai perdere valutazioni a cascata
do $$ begin
  alter table compilazione drop constraint if exists compilazione_scheda_id_fkey;
  alter table compilazione add constraint compilazione_scheda_id_fkey foreign key (scheda_id) references scena_scheda(id) on delete restrict;
  alter table compilazione drop constraint if exists compilazione_squadra_id_fkey;
  alter table compilazione add constraint compilazione_squadra_id_fkey foreign key (squadra_id) references squadra(id) on delete restrict;
  alter table risposta drop constraint if exists risposta_voce_id_fkey;
  alter table risposta add constraint risposta_voce_id_fkey foreign key (voce_id) references scena_scheda_voce(id) on delete restrict;
  alter table scena drop constraint if exists scena_evento_id_fkey;
  alter table scena add constraint scena_evento_id_fkey foreign key (evento_id) references evento(id) on delete restrict;
end $$;

-- risposte: annullo come tombstone e precedenza dell'organizzazione
alter table risposta alter column livello drop not null;
alter table risposta add column if not exists da_org boolean not null default false;

-- viste corrette (solo schede dello stesso evento, risposte annullate escluse, monitor solo squadre attive)
create or replace view v_punti_voce as
select r.compilazione_id, r.voce_id, c.squadra_id, c.scheda_id, v.is_sep,
       case r.livello when 'MB' then v.mb when 'BE' then v.be when 'SU' then v.su
                      when 'IN' then v."in" when 'NE' then v.ne end as punti,
       coalesce(greatest(v.mb, v.be, v.su, v."in", v.ne), 0) as punti_max
from risposta r
join compilazione c on c.id = r.compilazione_id
join scena_scheda_voce v on v.id = r.voce_id
where r.livello is not null;

create or replace view v_classifica as
select sq.evento_id, sq.id as squadra_id, sq.numero, sq.nome,
  coalesce(sum(p.punti),0)                                              as totale,
  coalesce(sum(p.punti) filter (where p.is_sep),0)                      as sep,
  coalesce(sum(p.punti) filter (where p.is_bls),0)                      as bls,
  coalesce(sum(p.punti) filter (where p.is_master),0)                   as master
from squadra sq
left join (
  select pv.squadra_id, pv.punti, pv.is_sep, s.is_bls, s.is_master, sc.evento_id
  from v_punti_voce pv
  join scena_scheda s on s.id = pv.scheda_id
  join scena sc on sc.id = s.scena_id
) p on p.squadra_id = sq.id and p.evento_id = sq.evento_id
group by sq.evento_id, sq.id, sq.numero, sq.nome;

create or replace view v_monitor as
select sc.evento_id, sc.codice as scena, sq.numero as squadra, sq.nome,
       s.slot, s.titolo as scheda, c.stato, c.giudice, c.origine, c.updated_at,
       (select count(*) from risposta r where r.compilazione_id = c.id and r.livello is not null) as voci_compilate,
       (select count(*) from scena_scheda_voce v where v.scheda_id = s.id) as voci_totali
from scena sc
join scena_scheda s on s.scena_id = sc.id
join squadra sq on sq.evento_id = sc.evento_id and sq.attiva
left join compilazione c on c.scheda_id = s.id and c.squadra_id = sq.id;
