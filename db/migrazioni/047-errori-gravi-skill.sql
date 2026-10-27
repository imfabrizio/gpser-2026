-- Errori gravi di una scheda (skill): elenco stampato nel riquadro "Sono errori gravi"
alter table patologia add column if not exists errori_gravi text[] not null default '{}';
update patologia set errori_gravi = '{"Non mantenere l''immobilizzazione manuale della testa","Palpazione di addome e bacino","Mancata sequenza ABCD"}' where codice in ('esame-ptc','esame-valutazione') and errori_gravi = '{}';
update patologia set errori_gravi = '{"Passare sopra al paziente","Non assicurare il paziente al presidio","Montaggio B-Lock dopo il posizionamento su barella"}' where codice = 'esame-scoop' and errori_gravi = '{}';
update patologia set errori_gravi = '{"Passare sopra al paziente","Non assicurare il paziente al presidio","Lasciare il capo prima del montaggio della cintura H"}' where codice in ('skill-scoop-trasporto','skill-scoop-semiverticale') and errori_gravi = '{}';
