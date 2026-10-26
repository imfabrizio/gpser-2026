-- coordinate degli eventi: città (ricavata da OpenStreetMap) e punto della segreteria (arrivi e registrazioni)
alter table evento add column if not exists lat numeric(9,6);
alter table evento add column if not exists lng numeric(9,6);
alter table evento add column if not exists segreteria_lat numeric(9,6);
alter table evento add column if not exists segreteria_lng numeric(9,6);
