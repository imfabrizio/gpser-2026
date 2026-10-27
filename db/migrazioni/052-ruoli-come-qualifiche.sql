-- Le qualifiche di formazione e di scena hanno un ruolo con lo stesso codice; la qualifica "discente TSSA" è solo un'etichetta
insert into ruolo (codice, nome, sistema, aree) values
  ('capo_monitore',  'Capo monitore',  false, '{formazione_esame,esami,valutazione}'),
  ('formatore_ms',   'Formatore MS',   false, '{formazione_esame,esami,valutazione}'),
  ('formatore_tssa', 'Formatore TSSA', false, '{formazione_esame,esami,valutazione}'),
  ('trainer_ms',     'Trainer MS',     false, '{formazione_esame,esami,valutazione}'),
  ('trainer_tssa',   'Trainer TSSA',   false, '{formazione_esame,esami,valutazione}'),
  ('istruttore_du',  'Istruttore DU',  false, '{formazione_esame,esami,valutazione}'),
  ('simulatore',     'Simulatore',     false, '{}'),
  ('truccatore',     'Truccatore',     false, '{}')
on conflict (codice) do nothing;
update ruolo set aree = array_append(aree, 'valutazione') where codice = 'monitore' and not ('valutazione' = any(aree));
-- «Manovre salvavita» diventa «Trainer MS»
update utente set ruolo = 'trainer_ms' where ruolo = 'manovre_salvavita';
insert into utente_ruolo_extra select utente_id, 'trainer_ms' from utente_ruolo_extra where ruolo = 'manovre_salvavita' on conflict do nothing;
delete from utente_ruolo_extra where ruolo = 'manovre_salvavita';
delete from ruolo where codice = 'manovre_salvavita';
insert into qualifica (codice, nome, ambito, sistema) values ('discente_tssa', 'Discente TSSA', null, true) on conflict do nothing;
-- chi ha già una qualifica con ruolo omonimo e un accesso riceve il ruolo (aggiuntivo)
insert into utente_ruolo_extra
  select distinct p.utente_id, pq.qualifica from persona_qualifica pq
  join partecipante p on p.id = pq.partecipante_id join utente u on u.id = p.utente_id join ruolo r on r.codice = pq.qualifica
  where u.ruolo <> pq.qualifica on conflict do nothing;
