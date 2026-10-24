-- Qualifiche permanenti della persona (titoli: giudice, simulatore, trainer…) e ruoli di accesso aggiuntivi dell'utente.
create table if not exists persona_qualifica (
  partecipante_id uuid not null references partecipante(id) on delete cascade,
  qualifica text not null check (qualifica in ('giudice','giudice_master','simulatore','truccatore','trainer','formatore','monitore','istruttore')),
  primary key (partecipante_id, qualifica)
);
create table if not exists utente_ruolo_extra (
  utente_id uuid not null references utente(id) on delete cascade,
  ruolo text not null references ruolo(codice) on delete cascade,
  primary key (utente_id, ruolo)
);
