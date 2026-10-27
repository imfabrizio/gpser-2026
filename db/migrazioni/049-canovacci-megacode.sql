-- Canovacci: oltre a Gara e Olimpiadi, la descrizione di uno scenario di Mega Code
alter table canovaccio drop constraint if exists canovaccio_versione_check;
alter table canovaccio add constraint canovaccio_versione_check check (versione in ('gara','olimpiadi','megacode'));
