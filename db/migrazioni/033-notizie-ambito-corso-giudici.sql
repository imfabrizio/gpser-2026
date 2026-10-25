-- notizie per ambito (gare = anche pubbliche, formazione = solo area Formazione) e nuovo tipo di evento «corso giudici»
alter table avviso add column if not exists ambito text not null default 'gare';
alter table avviso drop constraint if exists avviso_ambito_check;
alter table avviso add constraint avviso_ambito_check check (ambito in ('gare','formazione'));
alter table evento drop constraint if exists evento_tipo_check;
alter table evento add constraint evento_tipo_check check (tipo in ('gara','olimpiadi','allenamento','corso','esame','megacode','corso_giudici'));
