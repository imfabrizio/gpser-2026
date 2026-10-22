-- Aree Valutazione, Documentazione e Formazione d'esame; documenti per gli utenti registrati
update ruolo set aree = array_replace(aree, 'schede_comitato', 'formazione_esame');
update ruolo set aree = array_append(aree, 'valutazione') where codice in ('giudice', 'giudice_master', 'organizzazione') and not ('valutazione' = any(aree));
update ruolo set aree = array_append(aree, 'documentazione') where codice = 'organizzazione' and not ('documentazione' = any(aree));
create table if not exists documento (
  id          uuid primary key default gen_random_uuid(),
  categoria   text not null check (categoria in ('regolamento', 'comunicazioni', 'manuali', 'formazione', 'altro')),
  titolo      text not null check (length(titolo) between 1 and 150),
  descrizione text,
  url         text not null check (url ~ '^https://'),
  ordine      int  not null default 0,
  creato_da   uuid references utente(id) on delete set null,
  created_at  timestamptz not null default now()
);
