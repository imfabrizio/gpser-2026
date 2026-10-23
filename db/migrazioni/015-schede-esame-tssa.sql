-- Fasce di giudizio per scheda + le quattro schede d'esame TSSA (Skill 01 PTC, 03 Seggetta, 04 Valutazione, 15 Barella Scoop)
alter table patologia add column if not exists fasce jsonb;
alter table scena_scheda add column if not exists fasce jsonb;
insert into scala_punteggio (codice, mb, su, ne) values ('Esame 0-1-2', 2, 1, 0) on conflict (codice) do nothing;

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-ptc', 'Skill 01 – PTC', 'PTC', 'Esame TSSA', 'Mod. SKILL 01 · TSSA/01. Errori gravi: non mantenere l''immobilizzazione manuale della testa; palpazione di addome e bacino; mancata sequenza ABCD. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 32, "nome": "Sufficiente"}, {"da": 36, "nome": "Discreto"}, {"da": 40, "nome": "Buono"}, {"da": 44, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Sicurezza') on conflict do nothing;
insert into voce (testo) values ('AVECA/AVCEA') on conflict do nothing;
insert into voce (testo) values ('Controllo emorragie') on conflict do nothing;
insert into voce (testo) values ('Blocca manualmente il capo (approccio frontale) e controlla la pervietà (dichiara l''eventuale spessore)') on conflict do nothing;
insert into voce (testo) values ('Fa porre il collare cervicale (prende la misura, controlla giugulari e trachea)') on conflict do nothing;
insert into voce (testo) values ('Ossigeno ad alti flussi 12/15 l con maschera reservoir') on conflict do nothing;
insert into voce (testo) values ('O = Osservazione espansione toracica') on conflict do nothing;
insert into voce (testo) values ('PA = Palpo e ascolto (crepitii, rumori respiratori)') on conflict do nothing;
insert into voce (testo) values ('C = Conto atti respiratori') on conflict do nothing;
insert into voce (testo) values ('S = Saturimetria e regolazione O2') on conflict do nothing;
insert into voce (testo) values ('Controllo fonti emorragiche, cute e segni di shock') on conflict do nothing;
insert into voce (testo) values ('Conto atti respiratori') on conflict do nothing;
insert into voce (testo) values ('Pressione') on conflict do nothing;
insert into voce (testo) values ('AVPU – Disabilità motoria (valida anche in E)') on conflict do nothing;
insert into voce (testo) values ('E: taglia e ricopre con metallina') on conflict do nothing;
insert into voce (testo) values ('Controllo testa (neurocranio e splancnocranio)') on conflict do nothing;
insert into voce (testo) values ('Controllo collo (eventuale disabilità motoria se non fatta in E)') on conflict do nothing;
insert into voce (testo) values ('Controllo torace (tattile)') on conflict do nothing;
insert into voce (testo) values ('Controllo addome e bacino (solo visivo)') on conflict do nothing;
insert into voce (testo) values ('Controllo gambe') on conflict do nothing;
insert into voce (testo) values ('Controllo braccia') on conflict do nothing;
insert into voce (testo) values ('AMPLE') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Sicurezza'),
  (2, 'AVECA/AVCEA'),
  (3, 'Controllo emorragie'),
  (4, 'Blocca manualmente il capo (approccio frontale) e controlla la pervietà (dichiara l''eventuale spessore)'),
  (5, 'Fa porre il collare cervicale (prende la misura, controlla giugulari e trachea)'),
  (6, 'Ossigeno ad alti flussi 12/15 l con maschera reservoir'),
  (7, 'O = Osservazione espansione toracica'),
  (8, 'PA = Palpo e ascolto (crepitii, rumori respiratori)'),
  (9, 'C = Conto atti respiratori'),
  (10, 'S = Saturimetria e regolazione O2'),
  (11, 'Controllo fonti emorragiche, cute e segni di shock'),
  (12, 'Conto atti respiratori'),
  (13, 'Pressione'),
  (14, 'AVPU – Disabilità motoria (valida anche in E)'),
  (15, 'E: taglia e ricopre con metallina'),
  (16, 'Controllo testa (neurocranio e splancnocranio)'),
  (17, 'Controllo collo (eventuale disabilità motoria se non fatta in E)'),
  (18, 'Controllo torace (tattile)'),
  (19, 'Controllo addome e bacino (solo visivo)'),
  (20, 'Controllo gambe'),
  (21, 'Controllo braccia'),
  (22, 'AMPLE')
) as t(n, testo)
where p.codice='esame-ptc' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-valutazione', 'Skill 04 – Valutazione', 'VAL', 'Esame TSSA', 'Mod. SKILL 04 · TS/01. Errori gravi: non mantenere l''immobilizzazione manuale della testa; palpazione di addome e bacino; mancata sequenza ABCD. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 21, "nome": "Sufficiente"}, {"da": 22, "nome": "Discreto"}, {"da": 23, "nome": "Buono"}, {"da": 24, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Sicurezza') on conflict do nothing;
insert into voce (testo) values ('Controllo pervietà e coscienza') on conflict do nothing;
insert into voce (testo) values ('O = Osservazione espansione toracica') on conflict do nothing;
insert into voce (testo) values ('PA = Palpo e ascolto (crepitii, rumori respiratori)') on conflict do nothing;
insert into voce (testo) values ('C = Conto atti respiratori') on conflict do nothing;
insert into voce (testo) values ('S = Saturimetria e regolazione O2') on conflict do nothing;
insert into voce (testo) values ('Conto frequenza cardiaca') on conflict do nothing;
insert into voce (testo) values ('Pressione') on conflict do nothing;
insert into voce (testo) values ('Controllo colore cute') on conflict do nothing;
insert into voce (testo) values ('AVPU – Disabilità motoria (valida anche in E)') on conflict do nothing;
insert into voce (testo) values ('Segni e sintomi') on conflict do nothing;
insert into voce (testo) values ('AMPLE') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Sicurezza'),
  (2, 'Controllo pervietà e coscienza'),
  (3, 'O = Osservazione espansione toracica'),
  (4, 'PA = Palpo e ascolto (crepitii, rumori respiratori)'),
  (5, 'C = Conto atti respiratori'),
  (6, 'S = Saturimetria e regolazione O2'),
  (7, 'Conto frequenza cardiaca'),
  (8, 'Pressione'),
  (9, 'Controllo colore cute'),
  (10, 'AVPU – Disabilità motoria (valida anche in E)'),
  (11, 'Segni e sintomi'),
  (12, 'AMPLE')
) as t(n, testo)
where p.codice='esame-valutazione' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-seggetta', 'Skill 03 – Seggetta', 'SEG', 'Esame TSSA', 'Mod. SKILL 3 · TS/02 (10/11/2024). Errori gravi: passare sopra al paziente; non assicurare il paziente al presidio; montaggio B-Lock dopo il posizionamento su barella. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 21, "nome": "Sufficiente"}, {"da": 24, "nome": "Discreto"}, {"da": 26, "nome": "Buono"}, {"da": 28, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Apre il presidio assicurando il corretto bloccaggio di tutte le componenti') on conflict do nothing;
insert into voce (testo) values ('Slaccia le cinture') on conflict do nothing;
insert into voce (testo) values ('Si assicura del corretto bloccaggio delle ruote') on conflict do nothing;
insert into voce (testo) values ('Posiziona il presidio in maniera sicura per la successiva movimentazione del paziente') on conflict do nothing;
insert into voce (testo) values ('Fa posizionare il secondo operatore alle gambe del paziente') on conflict do nothing;
insert into voce (testo) values ('Prende il paziente sotto le ascelle') on conflict do nothing;
insert into voce (testo) values ('Mantiene le braccia del paziente') on conflict do nothing;
insert into voce (testo) values ('Si coordina col secondo operatore per lo spostamento') on conflict do nothing;
insert into voce (testo) values ('Sposta il paziente sulla sedia') on conflict do nothing;
insert into voce (testo) values ('Allaccia le cinture della sedia') on conflict do nothing;
insert into voce (testo) values ('Garantisce la protezione termica') on conflict do nothing;
insert into voce (testo) values ('Verifica la giusta tensione della cintura toracica') on conflict do nothing;
insert into voce (testo) values ('Estrae le maniglie di trasporto') on conflict do nothing;
insert into voce (testo) values ('Movimenta correttamente il presidio (scale o terreno accidentato)') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Apre il presidio assicurando il corretto bloccaggio di tutte le componenti'),
  (2, 'Slaccia le cinture'),
  (3, 'Si assicura del corretto bloccaggio delle ruote'),
  (4, 'Posiziona il presidio in maniera sicura per la successiva movimentazione del paziente'),
  (5, 'Fa posizionare il secondo operatore alle gambe del paziente'),
  (6, 'Prende il paziente sotto le ascelle'),
  (7, 'Mantiene le braccia del paziente'),
  (8, 'Si coordina col secondo operatore per lo spostamento'),
  (9, 'Sposta il paziente sulla sedia'),
  (10, 'Allaccia le cinture della sedia'),
  (11, 'Garantisce la protezione termica'),
  (12, 'Verifica la giusta tensione della cintura toracica'),
  (13, 'Estrae le maniglie di trasporto'),
  (14, 'Movimenta correttamente il presidio (scale o terreno accidentato)')
) as t(n, testo)
where p.codice='esame-seggetta' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);

insert into patologia (codice, nome, sigla, categoria, descrizione, fasce) values ('esame-scoop', 'Skill 15 – Barella Scoop EXL (trasporto)', 'SCO', 'Esame TSSA', 'Mod. SKILL 15 · TSSA/02 (10/11/2024). Errori gravi: passare sopra al paziente; non assicurare il paziente al presidio; montaggio B-Lock dopo il posizionamento su barella. Sulla scheda cartacea: capacità di leader.', '[{"da": 0, "nome": "Insufficiente"}, {"da": 21, "nome": "Sufficiente"}, {"da": 24, "nome": "Discreto"}, {"da": 26, "nome": "Buono"}, {"da": 28, "nome": "Ottimo"}]'::jsonb) on conflict (codice) do nothing;
insert into voce (testo) values ('Posiziona correttamente la base fermacapo') on conflict do nothing;
insert into voce (testo) values ('Posiziona correttamente i coni laterali') on conflict do nothing;
insert into voce (testo) values ('Posiziona correttamente la base fermacapo (punto 3)') on conflict do nothing;
insert into voce (testo) values ('Pone la scoop a lato del paziente e prende correttamente la misura (riferimento collo/testa)') on conflict do nothing;
insert into voce (testo) values ('Apre la barella in sicurezza (lontano dal paziente)') on conflict do nothing;
insert into voce (testo) values ('Sposta una valva al lato opposto senza passare sopra al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona le due valve sotto al paziente senza sollevarlo') on conflict do nothing;
insert into voce (testo) values ('Verifica la corretta chiusura della barella alla testa e ai piedi') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente le cinture toraciche incrociate (1sx-3dx, 1sx-3dx o 1sx-2dx, 1sx-2dx)') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente la cintura alle gambe (3sx-3dx)') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente la cintura ai piedi (otto)') on conflict do nothing;
insert into voce (testo) values ('Ferma il blocco testa con cintura H') on conflict do nothing;
insert into voce (testo) values ('Afferra correttamente la barella e assume la posizione più idonea al sollevamento') on conflict do nothing;
insert into voce (testo) values ('Solleva la barella in modo sincrono con l''altro operatore') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Posiziona correttamente la base fermacapo'),
  (2, 'Posiziona correttamente i coni laterali'),
  (3, 'Posiziona correttamente la base fermacapo (punto 3)'),
  (4, 'Pone la scoop a lato del paziente e prende correttamente la misura (riferimento collo/testa)'),
  (5, 'Apre la barella in sicurezza (lontano dal paziente)'),
  (6, 'Sposta una valva al lato opposto senza passare sopra al paziente'),
  (7, 'Posiziona le due valve sotto al paziente senza sollevarlo'),
  (8, 'Verifica la corretta chiusura della barella alla testa e ai piedi'),
  (9, 'Applica correttamente le cinture toraciche incrociate (1sx-3dx, 1sx-3dx o 1sx-2dx, 1sx-2dx)'),
  (10, 'Applica correttamente la cintura alle gambe (3sx-3dx)'),
  (11, 'Applica correttamente la cintura ai piedi (otto)'),
  (12, 'Ferma il blocco testa con cintura H'),
  (13, 'Afferra correttamente la barella e assume la posizione più idonea al sollevamento'),
  (14, 'Solleva la barella in modo sincrono con l''altro operatore')
) as t(n, testo)
where p.codice='esame-scoop' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
