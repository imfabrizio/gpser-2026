-- Comitati regionali/provinciali non presenti negli elenchi Gaia letti (Trentino-Alto Adige, Valle d'Aosta): unità da aggiungere a mano
insert into comitato (nome, regione, provincia) values
  ('Provincia Autonoma di Trento', 'Trentino-Alto Adige', 'TN'),
  ('Provincia Autonoma di Bolzano', 'Trentino-Alto Adige', 'BZ'),
  ('Valle d''Aosta', 'Valle d''Aosta', 'AO')
on conflict (lower(nome)) do nothing;
