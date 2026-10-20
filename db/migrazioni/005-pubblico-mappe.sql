-- news pubbliche, mappa del percorso gara, indirizzo/coordinate delle scene
alter table avviso add column if not exists pubblico boolean not null default false;
alter table evento add column if not exists mappa_url text;       -- incorporamento di Google My Maps (facoltativo)
alter table scena add column if not exists indirizzo text;
alter table scena add column if not exists lat numeric(9,6);
alter table scena add column if not exists lng numeric(9,6);
