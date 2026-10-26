-- canovacci: la lettera della scena non basta (A di una gara ≠ A di un'altra): si aggiunge il codice della gara (es. GPSER-2027, OLIER-2025)
alter table canovaccio add column if not exists gara_codice text;
alter table canovaccio drop constraint if exists canovaccio_codice_versione_key;
create unique index if not exists canovaccio_gara_scena_versione_uq on canovaccio ((coalesce(gara_codice, '')), codice, versione);
