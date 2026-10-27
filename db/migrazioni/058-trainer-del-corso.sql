-- Trainer e formatori del corso: attivi (valutatori di tutti i Mega Code) o in attesa di risposta se di un altro comitato
alter table evento_invito add column if not exists stato text not null default 'attivo' check (stato in ('attivo','richiesto','rifiutato'));
-- Proposte alla regione: chi ha proposto può ritirarle e tenere il materiale solo per sé
alter table promozione drop constraint if exists promozione_stato_check;
alter table promozione add constraint promozione_stato_check check (stato in ('in_attesa','approvata','rifiutata','ritirata'));
