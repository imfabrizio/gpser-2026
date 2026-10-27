-- Schede composte: una scheda (es. Valutazione) può incorporare altre skill, che diventano blocchi della scheda di scena.
-- Ogni blocco ha il proprio punteggio, le proprie fasce e i propri errori gravi; i suoi punti NON entrano nei totali della composta.
create table if not exists patologia_skill (
  patologia_id uuid not null references patologia(id) on delete cascade,
  dopo_ordine  int  not null,                                  -- la skill si apre subito dopo questa voce della composta
  skill_id     uuid not null references patologia(id) on delete restrict,
  primary key (patologia_id, skill_id),
  check (patologia_id <> skill_id)
);
alter table scena_scheda_voce add column if not exists blocco_id uuid;     -- patologia della skill incorporata (null = voce della scheda stessa)
alter table scena_scheda_voce add column if not exists blocco_nome text;

create or replace view v_punti_voce as
select r.compilazione_id, r.voce_id, c.squadra_id, c.scheda_id, v.is_sep,
       case r.livello when 'MB' then v.mb when 'BE' then v.be when 'SU' then v.su
                      when 'IN' then v."in" when 'NE' then v.ne end as punti,
       coalesce(greatest(v.mb, v.be, v.su, v."in", v.ne), 0) as punti_max
from risposta r
join compilazione c on c.id = r.compilazione_id
join scena_scheda_voce v on v.id = r.voce_id
where r.livello is not null and v.blocco_id is null;

create or replace view v_massimi_evento as
select sc.evento_id,
  sum(greatest(v.mb, v.be, v.su, v."in", v.ne))                         as max_totale,
  sum(greatest(v.mb, v.be, v.su, v."in", v.ne)) filter (where v.is_sep) as max_sep
from scena sc
join scena_scheda s on s.scena_id = sc.id
join scena_scheda_voce v on v.scheda_id = s.id
where v.blocco_id is null
group by sc.evento_id;
