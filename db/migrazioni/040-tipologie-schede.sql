-- tipologia d'uso delle schede in libreria: gara, olimpiadi, megacode, skill (una scheda può servire a più tipi)
alter table patologia add column if not exists tipologie text[] not null default '{gara,olimpiadi,megacode,skill}';
-- le schede importate dalle gare portano già il tipo nel nome («Tipo · Gara A», «Tipo · Olimpiadi A»)
update patologia set tipologie = '{olimpiadi}' where nome ~* '· olimpiadi ' and tipologie = '{gara,olimpiadi,megacode,skill}';
update patologia set tipologie = '{gara}' where nome ~* '· gara ' and tipologie = '{gara,olimpiadi,megacode,skill}';
