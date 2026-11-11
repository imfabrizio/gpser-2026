-- Ambito regionale: il formatore opera come un trainer, ma in tutta la propria regione (non in tutta Italia)
alter table qualifica drop constraint if exists qualifica_ambito_check;
alter table qualifica add constraint qualifica_ambito_check check (ambito in ('locale','regionale','nazionale','formazione'));
update qualifica set ambito = 'regionale' where codice in ('formatore_tssa', 'formatore_ms');
