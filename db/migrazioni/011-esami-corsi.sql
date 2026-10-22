-- Altri tipi di evento (allenamento, corso, esame), soglia di superamento e punteggi visibili ai giudici
alter table evento drop constraint if exists evento_tipo_check;
alter table evento add constraint evento_tipo_check check (tipo in ('gara','olimpiadi','allenamento','corso','esame'));
alter table evento add column if not exists soglia_pct numeric(5,2) check (soglia_pct between 1 and 100);
alter table evento add column if not exists mostra_punteggi boolean not null default false;
