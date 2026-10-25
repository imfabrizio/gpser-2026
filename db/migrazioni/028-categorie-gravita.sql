-- Categorie principali delle schede (con priorità) e codice di gravità rosso/giallo/verde
create table if not exists macro_categoria (
  codice   text primary key,
  nome     text not null,
  priorita int  not null,                       -- 1 = più urgente: ordina i pazienti a parità di gravità
  gravita  text not null check (gravita in ('rosso','giallo','verde'))   -- gravità proposta per le schede della categoria
);
insert into macro_categoria (codice, nome, priorita, gravita) values
  ('arresto',  'Arresto e rianimazione',   1, 'rosso'),
  ('cardio',   'Cardiocircolatorie',       2, 'rosso'),
  ('respiro',  'Respiratorie',             3, 'rosso'),
  ('neuro',    'Neurologiche',             4, 'rosso'),
  ('trauma',   'Traumatiche',              5, 'giallo'),
  ('ambiente', 'Ambientali e da agenti',   6, 'giallo'),
  ('metab',    'Metaboliche',              7, 'giallo'),
  ('ostpe',    'Ostetriche e pediatriche', 8, 'giallo'),
  ('comp',     'Comportamentali',          9, 'verde')
on conflict (codice) do nothing;

alter table patologia add column if not exists macro   text references macro_categoria(codice);
alter table patologia add column if not exists macro2  text references macro_categoria(codice);
alter table patologia add column if not exists gravita text;
alter table scena_scheda add column if not exists gravita text;
alter table scena_scheda add column if not exists macro   text;
alter table patologia drop constraint if exists patologia_gravita_check;
alter table patologia add constraint patologia_gravita_check check (gravita is null or gravita in ('rosso','giallo','verde'));
alter table scena_scheda drop constraint if exists scena_scheda_gravita_check;
alter table scena_scheda add constraint scena_scheda_gravita_check check (gravita is null or gravita in ('rosso','giallo','verde'));

-- proposta iniziale dalle parole del nome: la prima regola che corrisponde decide; si corregge dall'editor
create or replace function pg_temp.macro_di(t text) returns text language sql immutable as $$
  select case
    when t ~* '(\mbls|\mpbls|blsd|\macc\M|arresto|rcp|rianimaz)' then 'arresto'
    when t ~* '(infarto|cardiac|angina|shock|ipotensione|aritmi)' then 'cardio'
    when t ~* '(asma|soffoc|annega|respir|pneumot|ostruz|anafilass|\mpnx\M)' then 'respiro'
    when t ~* '(ictus|epiless|epilett|convuls|sincope|svenim|neurolog|\mcoma\M|lipotim)' then 'neuro'
    when t ~* '(autist|disturbator)' then 'comp'
    when t ~* '(frattur|ferita|ampu|conficc|eviscer|trauma|caduta|investit|emorrag|schiacc|\mtc\M|volet)' then 'trauma'
    when t ~* '(ustion|folgor|sole|calore|ipoterm|vipera|morso|intossic|avvelen|overdose|elettr)' then 'ambiente'
    when t ~* '(ipoglic|iperglic|diabet|metabol)' then 'metab'
    when t ~* '(\mpart[oi]\M|partoriente|gravid|bambin|pediatr|neonat)' then 'ostpe'
    when t ~* '(agitat|ubriac|panico|autist|alzheimer|psich|demenz|euforic)' then 'comp'
    else null end
$$;
update patologia set macro = pg_temp.macro_di(coalesce(categoria,'') || ' ' || nome)
 where macro is null and not is_master;
update patologia set macro2 = pg_temp.macro_di(categoria2) where macro2 is null and categoria2 is not null and macro2 is distinct from macro;
update patologia p set gravita = coalesce(case when (coalesce(categoria,'') || ' ' || nome) ~* 'emorrag|arresto|\mbls|blsd' then 'rosso' end,
                                          (select gravita from macro_categoria m where m.codice = p.macro))
 where gravita is null and not is_master;
update scena_scheda s set gravita = p.gravita, macro = p.macro from patologia p where s.patologia_id = p.id and s.gravita is null and s.macro is null and not s.is_master;
