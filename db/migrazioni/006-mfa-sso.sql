-- MFA (TOTP) e accesso con provider esterni (Google, Microsoft)
alter table utente add column if not exists mfa_secret text;                 -- segreto TOTP cifrato
alter table utente add column if not exists mfa_attiva boolean not null default false;
alter table utente add column if not exists mfa_recupero text[] not null default '{}';   -- hash dei codici di recupero
create table if not exists utente_identita (
  provider  text not null,
  sub       text not null,
  utente_id uuid not null references utente(id) on delete cascade,
  email     text,
  creata_at timestamptz not null default now(),
  primary key (provider, sub)
);
