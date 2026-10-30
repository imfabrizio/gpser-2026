-- Sopralluogo: percorso registrato (elenco di punti) della gara; le posizioni delle scene stanno già in scena.lat/lng
alter table evento add column if not exists percorso jsonb;
