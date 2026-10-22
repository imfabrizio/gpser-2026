-- Schede private di un comitato (create da istruttori, manovre salvavita, monitori)
alter table patologia add column if not exists comitato text;                                   -- null = libreria generale
alter table patologia add column if not exists creata_da uuid references utente(id) on delete set null;
create index if not exists patologia_comitato_idx on patologia (lower(comitato));
insert into ruolo (codice, nome, sistema, aree) values
  ('istruttore', 'Istruttore', false, '{schede_comitato}'),
  ('manovre_salvavita', 'Manovre salvavita', false, '{schede_comitato}'),
  ('monitore', 'Monitore', false, '{schede_comitato}')
on conflict (codice) do nothing;
