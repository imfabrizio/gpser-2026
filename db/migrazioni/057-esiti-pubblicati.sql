-- Il docente pubblica gli esiti di un Mega Code/esame: da quel momento ogni discente li vede nel suo storico
alter table evento add column if not exists esiti_pubblicati_at timestamptz;
