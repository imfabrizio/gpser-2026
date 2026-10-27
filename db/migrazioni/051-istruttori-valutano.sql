-- Nei corsi e nei Mega Code valutano gli istruttori/formatori: serve l'area valutazione
update ruolo set aree = array_append(aree, 'valutazione') where codice = 'istruttore' and not ('valutazione' = any(aree));
