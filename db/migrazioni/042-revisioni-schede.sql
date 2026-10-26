-- revisioni delle schede di libreria: ogni revisione è una scheda (patologia) del gruppo, con data e gara di origine
alter table patologia add column if not exists gruppo_id uuid;
alter table patologia add column if not exists revisione int not null default 1;
alter table patologia add column if not exists creata_il timestamptz not null default now();
alter table patologia add column if not exists evento_origine_id uuid references evento(id) on delete set null;
update patologia set gruppo_id = id where gruppo_id is null;
alter table patologia alter column gruppo_id set default gen_random_uuid();
alter table patologia alter column gruppo_id set not null;
create unique index if not exists patologia_gruppo_rev_uq on patologia (gruppo_id, revisione);
