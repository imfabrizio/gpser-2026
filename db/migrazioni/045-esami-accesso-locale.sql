-- Nessun dato viene eliminato. Sessioni senza proprietario riconoscibile: solo admin.
alter table sessione_esame add column if not exists comitato text;
update sessione_esame s set comitato = (
  select p.comitato from partecipante p where p.utente_id=s.creato_da and p.comitato is not null order by p.created_at, p.id limit 1
) where s.comitato is null;
create table if not exists sessione_esame_invito (
  sessione_id uuid not null references sessione_esame(id) on delete cascade,
  utente_id uuid not null references utente(id) on delete cascade,
  invitato_da uuid references utente(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (sessione_id, utente_id)
);
create index if not exists sessione_esame_invito_utente_idx on sessione_esame_invito (utente_id);
