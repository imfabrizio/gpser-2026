-- Aspetto scelto dall'utente (tre layout)
alter table utente add column if not exists tema text check (tema in ('a', 'b', 'c'));
