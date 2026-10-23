-- Tipo di evento «Mega Code»: formativo, struttura come le gare (squadra, scene, schede) ma senza classifica come obiettivo
alter table evento drop constraint if exists evento_tipo_check;
alter table evento add constraint evento_tipo_check check (tipo in ('gara','olimpiadi','allenamento','corso','esame','megacode'));
