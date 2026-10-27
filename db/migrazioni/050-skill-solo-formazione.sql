-- Le skill (schede d'esame TSSA e Scoop) si usano solo nei Mega Code e negli esami: fuori da gare, olimpiadi e allenamenti
update patologia set tipologie = '{skill}' where categoria = 'Esame TSSA' or codice like 'skill-scoop-%';
