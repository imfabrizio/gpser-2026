-- registrazione con email e password (oltre a Google/Microsoft): la richiesta porta con sé password e MFA, attivi solo se l'amministratore approva
alter table richiesta_accesso add column if not exists password_hash text;
alter table richiesta_accesso add column if not exists mfa_secret text;          -- cifrato
alter table richiesta_accesso add column if not exists mfa_ok boolean not null default false;
alter table richiesta_accesso add column if not exists mfa_recupero text[] not null default '{}';
