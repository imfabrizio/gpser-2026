-- il luogo di un evento si sceglie da un elenco di comuni (regione, provincia, comune): da lì si ricavano le coordinate
alter table evento add column if not exists comune_istat text;
alter table evento add column if not exists luogo_provincia text;
alter table evento add column if not exists luogo_regione text;
