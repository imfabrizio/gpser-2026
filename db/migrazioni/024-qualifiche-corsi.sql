-- Qualifiche gestibili (si possono aggiungere nuove), numero del corso su Gaia, e collegamento di Mega Code ed esami al corso.
create table if not exists qualifica (
  codice  text primary key,
  nome    text not null,
  ambito  text check (ambito in ('locale','nazionale')),   -- trainer/monitore: locale; formatore/capo monitore: nazionale
  sistema boolean not null default false
);
insert into qualifica (codice, nome, ambito, sistema) values
  ('giudice','Giudice',null,true), ('giudice_master','Giudice master',null,true), ('simulatore','Simulatore',null,true), ('truccatore','Truccatore',null,true),
  ('trainer_ms','Trainer MS','locale',true), ('trainer_tssa','Trainer TSSA','locale',true), ('monitore','Monitore','locale',true),
  ('formatore_ms','Formatore MS','nazionale',true), ('formatore_tssa','Formatore TSSA','nazionale',true), ('capo_monitore','Capo monitore','nazionale',true)
on conflict do nothing;
alter table persona_qualifica drop constraint if exists persona_qualifica_qualifica_check;
delete from persona_qualifica where qualifica not in (select codice from qualifica);
alter table persona_qualifica drop constraint if exists persona_qualifica_qualifica_fk;
alter table persona_qualifica add constraint persona_qualifica_qualifica_fk foreign key (qualifica) references qualifica(codice) on delete restrict;
alter table evento add column if not exists codice_gaia text;                                    -- numero assegnato da Gaia al corso
alter table evento add column if not exists corso_id uuid references evento(id) on delete set null;   -- Mega Code / esami figli di un corso
alter table sessione_esame add column if not exists evento_id uuid references evento(id) on delete set null;
