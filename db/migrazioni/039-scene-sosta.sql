-- scene di sosta: posizioni senza schede (attività ludica o attesa) quando le squadre sono più delle scene giocate
alter table scena add column if not exists sosta boolean not null default false;
