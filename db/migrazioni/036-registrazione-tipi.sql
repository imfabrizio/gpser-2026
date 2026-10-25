-- registrazione a tre scelte (supporter, aspirante volontario, volontario CRI) con qualifiche dichiarate, da confermare in approvazione
alter table richiesta_accesso add column if not exists tipo_registrazione text;
alter table richiesta_accesso add column if not exists data_nascita date;
alter table richiesta_accesso add column if not exists luogo_nascita text;
alter table richiesta_accesso add column if not exists qualifiche text[] not null default '{}';
alter table richiesta_accesso add column if not exists cf_avvisi text[] not null default '{}';
alter table partecipante add column if not exists luogo_nascita text;
insert into qualifica (codice, nome, ambito, sistema) values ('operatore_tssa','Operatore TSSA',null,true), ('istruttore_du','Istruttore DU',null,true) on conflict do nothing;
