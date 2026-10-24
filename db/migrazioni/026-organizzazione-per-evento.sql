-- Organizzazione limitata alle gare a cui la persona è iscritta con ruolo «organizzazione» (invece che a tutte).
alter table utente add column if not exists per_evento boolean not null default false;
