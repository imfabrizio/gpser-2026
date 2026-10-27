-- L'Istruttore DU può aprire corsi, Mega Code ed esami per il proprio comitato (come i trainer)
update qualifica set ambito = 'locale' where codice = 'istruttore_du' and ambito is null;
