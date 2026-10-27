-- Nuove skill (collare, pronosupinazione, casco, sedia, barella Scoop 2020, XT) e schede dei 4 scenari Mega Code, con le skill incorporate nelle schede.
-- Le fasce di giudizio sono automatiche (75/80/85/95%).
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('skill-02-collare', 'Skill 02 – Collare cervicale monovalva', 'COL', 'Esame TSSA', 'Mod. SKILL 02 · TSSA/01. Collare cervicale monovalva. Fasce automatiche.', '{skill}', '{"Non verificare la posizione neutra","Non garantire l''allineamento del rachide","Posizionare un collare di misura sbagliata","Muovere il paziente durante la manovra"}') on conflict (codice) do nothing;
insert into voce (testo) values ('Si approccia frontalmente') on conflict do nothing;
insert into voce (testo) values ('Immobilizza correttamente la testa') on conflict do nothing;
insert into voce (testo) values ('Fa immobilizzare la testa al secondo operatore') on conflict do nothing;
insert into voce (testo) values ('Fa allineare il rachide in posizione neutra') on conflict do nothing;
insert into voce (testo) values ('Scopre il collo e rimuove eventuali monili') on conflict do nothing;
insert into voce (testo) values ('Verifica l''allineamento della trachea e le giugulari') on conflict do nothing;
insert into voce (testo) values ('Prende correttamente la misura del presidio') on conflict do nothing;
insert into voce (testo) values ('Infila la parte posteriore dietro al collo del paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona la parte frontale del collare') on conflict do nothing;
insert into voce (testo) values ('Chiude correttamente il collare') on conflict do nothing;
insert into voce (testo) values ('Verifica il corretto posizionamento del collare cervicale') on conflict do nothing;
insert into voce (testo) values ('Verifica il collo e l''apertura della bocca') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Valutazione tecnica', 'Si approccia frontalmente'),
  (2, 'Valutazione tecnica', 'Immobilizza correttamente la testa'),
  (3, 'Valutazione tecnica', 'Fa immobilizzare la testa al secondo operatore'),
  (4, 'Valutazione tecnica', 'Fa allineare il rachide in posizione neutra'),
  (5, 'Valutazione tecnica', 'Scopre il collo e rimuove eventuali monili'),
  (6, 'Valutazione tecnica', 'Verifica l''allineamento della trachea e le giugulari'),
  (7, 'Valutazione tecnica', 'Prende correttamente la misura del presidio'),
  (8, 'Valutazione tecnica', 'Infila la parte posteriore dietro al collo del paziente'),
  (9, 'Valutazione tecnica', 'Posiziona la parte frontale del collare'),
  (10, 'Valutazione tecnica', 'Chiude correttamente il collare'),
  (11, 'Valutazione tecnica', 'Verifica il corretto posizionamento del collare cervicale'),
  (12, 'Valutazione tecnica', 'Verifica il collo e l''apertura della bocca')
) as t(n, sez, testo) where p.codice='skill-02-collare' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('skill-05-pronosupinazione', 'Skill 05 – Pronosupinazione su tavola spinale', 'PSP', 'Esame TSSA', 'Mod. SKILL 05 · TSSA/01. Pronosupinazione su tavola spinale. Fasce automatiche.', '{skill}', '{"Eseguire la rotazione in maniera non coordinata","Non prendere la testa dopo la manovra per permettere il posizionamento dell''altro soccorritore"}') on conflict (codice) do nothing;
insert into voce (testo) values ('Fa posizionare un soccorritore per bloccare la testa') on conflict do nothing;
insert into voce (testo) values ('Allinea gli arti') on conflict do nothing;
insert into voce (testo) values ('Posiziona la tavola spinale tra paziente e soccorritori') on conflict do nothing;
insert into voce (testo) values ('Si posiziona all''altezza del busto del paziente') on conflict do nothing;
insert into voce (testo) values ('Fa posizionare il terzo soccorritore alle gambe') on conflict do nothing;
insert into voce (testo) values ('Fa posizionare le mani al soccorritore ai piedi (gamba-fianco)') on conflict do nothing;
insert into voce (testo) values ('Posiziona le mani sul paziente (spalla-bacino)') on conflict do nothing;
insert into voce (testo) values ('Esegue la rotazione del paziente con il coordinamento del soccorritore in testa') on conflict do nothing;
insert into voce (testo) values ('Si affretta a immobilizzare la testa') on conflict do nothing;
insert into voce (testo) values ('Lascia che il soccorritore di testa riprenda l''immobilizzazione del capo') on conflict do nothing;
insert into voce (testo) values ('Coordina eventuale correzione del posizionamento') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Valutazione tecnica', 'Fa posizionare un soccorritore per bloccare la testa'),
  (2, 'Valutazione tecnica', 'Allinea gli arti'),
  (3, 'Valutazione tecnica', 'Posiziona la tavola spinale tra paziente e soccorritori'),
  (4, 'Valutazione tecnica', 'Si posiziona all''altezza del busto del paziente'),
  (5, 'Valutazione tecnica', 'Fa posizionare il terzo soccorritore alle gambe'),
  (6, 'Valutazione tecnica', 'Fa posizionare le mani al soccorritore ai piedi (gamba-fianco)'),
  (7, 'Valutazione tecnica', 'Posiziona le mani sul paziente (spalla-bacino)'),
  (8, 'Valutazione tecnica', 'Esegue la rotazione del paziente con il coordinamento del soccorritore in testa'),
  (9, 'Valutazione tecnica', 'Si affretta a immobilizzare la testa'),
  (10, 'Valutazione tecnica', 'Lascia che il soccorritore di testa riprenda l''immobilizzazione del capo'),
  (11, 'Valutazione tecnica', 'Coordina eventuale correzione del posizionamento')
) as t(n, sez, testo) where p.codice='skill-05-pronosupinazione' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('skill-10-casco', 'Skill 10 – Estrazione del casco', 'CAS', 'Esame TSSA', 'Mod. SKILL 10 · TSSA/01. Estrazione del casco. Fasce automatiche.', '{skill}', '{"Non garantire l''immobilizzazione della testa"}') on conflict (codice) do nothing;
insert into voce (testo) values ('Si approccia frontalmente al paziente') on conflict do nothing;
insert into voce (testo) values ('Immobilizza il capo') on conflict do nothing;
insert into voce (testo) values ('Fa bloccare la testa dal secondo operatore (dietro)') on conflict do nothing;
insert into voce (testo) values ('Allinea il paziente ed effettua l''eventuale pronosupinazione (con secondo operatore)') on conflict do nothing;
insert into voce (testo) values ('Apre la visiera, rimuove eventuali occhiali e slaccia il casco') on conflict do nothing;
insert into voce (testo) values ('Immobilizza correttamente la testa per liberare l''altro operatore') on conflict do nothing;
insert into voce (testo) values ('Fa eseguire correttamente la prima parte dell''estrazione del casco fino a vedere il naso') on conflict do nothing;
insert into voce (testo) values ('Fa completare la rimozione del casco mantenendo la testa') on conflict do nothing;
insert into voce (testo) values ('Allinea la testa e la fa accompagnare a terra') on conflict do nothing;
insert into voce (testo) values ('Posiziona il collare cervicale') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Valutazione tecnica', 'Si approccia frontalmente al paziente'),
  (2, 'Valutazione tecnica', 'Immobilizza il capo'),
  (3, 'Valutazione tecnica', 'Fa bloccare la testa dal secondo operatore (dietro)'),
  (4, 'Valutazione tecnica', 'Allinea il paziente ed effettua l''eventuale pronosupinazione (con secondo operatore)'),
  (5, 'Valutazione tecnica', 'Apre la visiera, rimuove eventuali occhiali e slaccia il casco'),
  (6, 'Valutazione tecnica', 'Immobilizza correttamente la testa per liberare l''altro operatore'),
  (7, 'Valutazione tecnica', 'Fa eseguire correttamente la prima parte dell''estrazione del casco fino a vedere il naso'),
  (8, 'Valutazione tecnica', 'Fa completare la rimozione del casco mantenendo la testa'),
  (9, 'Valutazione tecnica', 'Allinea la testa e la fa accompagnare a terra'),
  (10, 'Valutazione tecnica', 'Posiziona il collare cervicale')
) as t(n, sez, testo) where p.codice='skill-10-casco' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('skill-12-sedia-portantina', 'Skill 12 – Sedia portantina', 'SED', 'Esame TSSA', 'Mod. SKILL 12 · TSSA/01. Sedia portantina. Fasce automatiche.', '{skill}', '{"Non assicurare il corretto bloccaggio di tutte le componenti","Non bloccare le ruote","Non allacciare correttamente le cinture"}') on conflict (codice) do nothing;
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
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Valutazione tecnica', 'Apre il presidio assicurando il corretto bloccaggio di tutte le componenti'),
  (2, 'Valutazione tecnica', 'Slaccia le cinture'),
  (3, 'Valutazione tecnica', 'Si assicura del corretto bloccaggio delle ruote'),
  (4, 'Valutazione tecnica', 'Posiziona il presidio in maniera sicura per la successiva movimentazione del paziente'),
  (5, 'Valutazione tecnica', 'Fa posizionare il secondo operatore alle gambe del paziente'),
  (6, 'Valutazione tecnica', 'Prende il paziente sotto le ascelle'),
  (7, 'Valutazione tecnica', 'Mantiene le braccia del paziente'),
  (8, 'Valutazione tecnica', 'Si coordina col secondo operatore per lo spostamento'),
  (9, 'Valutazione tecnica', 'Sposta il paziente sulla sedia'),
  (10, 'Valutazione tecnica', 'Allaccia le cinture della sedia'),
  (11, 'Valutazione tecnica', 'Garantisce la protezione termica'),
  (12, 'Valutazione tecnica', 'Verifica la giusta tensione della cintura toracica'),
  (13, 'Valutazione tecnica', 'Estrae le maniglie di trasporto'),
  (14, 'Valutazione tecnica', 'Movimenta correttamente il presidio (scale o terreno accidentato)')
) as t(n, sez, testo) where p.codice='skill-12-sedia-portantina' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('skill-14-scoop-2020', 'Skill 14 – Barella Scoop (ver. 2020)', 'SC2', 'Esame TSSA', 'Mod. SKILL 14 · TSSA/01 (ver. 28/01/2020). Barella Scoop. Fasce automatiche.', '{skill}', '{"Passare sopra al paziente","Non assicurare il paziente al presidio","Utilizzare blocchi fermacapo non idonei"}') on conflict (codice) do nothing;
insert into voce (testo) values ('Allinea il paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona la base fermacapo sotto la testa del paziente') on conflict do nothing;
insert into voce (testo) values ('Applica i blocchi fermacapo e le fasce frontale e mentoniera') on conflict do nothing;
insert into voce (testo) values ('Pone la scoop a lato del paziente e prende correttamente la misura') on conflict do nothing;
insert into voce (testo) values ('Apre la barella') on conflict do nothing;
insert into voce (testo) values ('Sposta una valva al lato opposto senza passare sopra al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona le due valve sotto al paziente senza sollevarlo') on conflict do nothing;
insert into voce (testo) values ('Verifica la corretta chiusura della barella alla testa e ai piedi') on conflict do nothing;
insert into voce (testo) values ('Applica correttamente le 4 cinghie (immobilizzazione: incrocio sul torace, bacino e piedi; semiverticalizzazione: torace sotto il cavo ascellare, inguinali, piedi)') on conflict do nothing;
insert into voce (testo) values ('Applica la fascia velcro ad H') on conflict do nothing;
insert into voce (testo) values ('Afferra correttamente la barella e assume la posizione più idonea al sollevamento') on conflict do nothing;
insert into voce (testo) values ('Solleva la barella in modo sincrono con l''altro operatore') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Valutazione tecnica', 'Allinea il paziente'),
  (2, 'Valutazione tecnica', 'Posiziona la base fermacapo sotto la testa del paziente'),
  (3, 'Valutazione tecnica', 'Applica i blocchi fermacapo e le fasce frontale e mentoniera'),
  (4, 'Valutazione tecnica', 'Pone la scoop a lato del paziente e prende correttamente la misura'),
  (5, 'Valutazione tecnica', 'Apre la barella'),
  (6, 'Valutazione tecnica', 'Sposta una valva al lato opposto senza passare sopra al paziente'),
  (7, 'Valutazione tecnica', 'Posiziona le due valve sotto al paziente senza sollevarlo'),
  (8, 'Valutazione tecnica', 'Verifica la corretta chiusura della barella alla testa e ai piedi'),
  (9, 'Valutazione tecnica', 'Applica correttamente le 4 cinghie (immobilizzazione: incrocio sul torace, bacino e piedi; semiverticalizzazione: torace sotto il cavo ascellare, inguinali, piedi)'),
  (10, 'Valutazione tecnica', 'Applica la fascia velcro ad H'),
  (11, 'Valutazione tecnica', 'Garantisce la protezione termica'),
  (12, 'Valutazione tecnica', 'Afferra correttamente la barella e assume la posizione più idonea al sollevamento'),
  (13, 'Valutazione tecnica', 'Solleva la barella in modo sincrono con l''altro operatore')
) as t(n, sez, testo) where p.codice='skill-14-scoop-2020' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('skill-15-xt', 'Skill 15 – Estricatore XT (estricazione cautelativa)', 'XTC', 'Esame TSSA', 'Mod. SKILL 15 · TSSA/01. Dispositivo di estricazione XT, estricazione cautelativa. Fasce automatiche.', '{skill}', '{"Non garantire l''immobilizzazione del rachide","Muovere eccessivamente il paziente durante la manovra","Non garantire il corretto fissaggio delle cinghie"}') on conflict (codice) do nothing;
insert into voce (testo) values ('Immobilizza frontalmente la testa') on conflict do nothing;
insert into voce (testo) values ('Verifica che il secondo operatore mantenga l''immobilizzazione da dietro') on conflict do nothing;
insert into voce (testo) values ('Posiziona correttamente il collare cervicale') on conflict do nothing;
insert into voce (testo) values ('Sposta il paziente in avanti bloccando testa e collo, lasciando dietro lo spazio per l''estricatore') on conflict do nothing;
insert into voce (testo) values ('Inserisce l''estricatore XT dietro al paziente in modo centrato, con cinghie e maniglie disposte lateralmente e pronte all''uso') on conflict do nothing;
insert into voce (testo) values ('Riposiziona il paziente sull''estricatore') on conflict do nothing;
insert into voce (testo) values ('Applica il triangolo fermacapo sopra le sopracciglia del paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona (entrambi gli operatori) le cinghie toraciche (gialla e rossa) incrociate, regola la tensione e lascia libere le maniglie rosse sopra le spalle') on conflict do nothing;
insert into voce (testo) values ('Posiziona (entrambi gli operatori) le cinghie inguinali (nera e verde), ognuna sullo stesso lato, evitando compressioni') on conflict do nothing;
insert into voce (testo) values ('Posiziona la fascia rossa per il fissaggio definitivo del rachide cervicale') on conflict do nothing;
insert into voce (testo) values ('Si assicura, assieme all''altro operatore, di aver applicato e regolato tutti i sistemi di fissaggio') on conflict do nothing;
insert into voce (testo) values ('Afferra correttamente le maniglie rosse di sollevamento e trasporto') on conflict do nothing;
insert into voce (testo) values ('Invita il paziente a mantenere le braccia sul petto') on conflict do nothing;
insert into voce (testo) values ('Completa l''estricazione coordinandosi con gli altri operatori, posizionando il paziente sul presidio scelto (spinale o scoop)') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Valutazione tecnica', 'Immobilizza frontalmente la testa'),
  (2, 'Valutazione tecnica', 'Verifica che il secondo operatore mantenga l''immobilizzazione da dietro'),
  (3, 'Valutazione tecnica', 'Posiziona correttamente il collare cervicale'),
  (4, 'Valutazione tecnica', 'Sposta il paziente in avanti bloccando testa e collo, lasciando dietro lo spazio per l''estricatore'),
  (5, 'Valutazione tecnica', 'Inserisce l''estricatore XT dietro al paziente in modo centrato, con cinghie e maniglie disposte lateralmente e pronte all''uso'),
  (6, 'Valutazione tecnica', 'Riposiziona il paziente sull''estricatore'),
  (7, 'Valutazione tecnica', 'Applica il triangolo fermacapo sopra le sopracciglia del paziente'),
  (8, 'Valutazione tecnica', 'Posiziona (entrambi gli operatori) le cinghie toraciche (gialla e rossa) incrociate, regola la tensione e lascia libere le maniglie rosse sopra le spalle'),
  (9, 'Valutazione tecnica', 'Posiziona (entrambi gli operatori) le cinghie inguinali (nera e verde), ognuna sullo stesso lato, evitando compressioni'),
  (10, 'Valutazione tecnica', 'Posiziona la fascia rossa per il fissaggio definitivo del rachide cervicale'),
  (11, 'Valutazione tecnica', 'Si assicura, assieme all''altro operatore, di aver applicato e regolato tutti i sistemi di fissaggio'),
  (12, 'Valutazione tecnica', 'Afferra correttamente le maniglie rosse di sollevamento e trasporto'),
  (13, 'Valutazione tecnica', 'Invita il paziente a mantenere le braccia sul petto'),
  (14, 'Valutazione tecnica', 'Completa l''estricazione coordinandosi con gli altri operatori, posizionando il paziente sul presidio scelto (spinale o scoop)')
) as t(n, sez, testo) where p.codice='skill-15-xt' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('mc-scenario-1-spinale', 'Mega Code – Scenario trauma 1: infortunio domestico', 'MC1', 'Mega Code', 'Pronosupinazione su tavola spinale. Scheda di valutazione per fasi (PHTC).', '{megacode}', '{}') on conflict (codice) do nothing;
insert into voce (testo) values ('Assegna ruoli e compiti') on conflict do nothing;
insert into voce (testo) values ('Indossa presidi di protezione individuali') on conflict do nothing;
insert into voce (testo) values ('Controlla la presenza di pericoli') on conflict do nothing;
insert into voce (testo) values ('Sicurezza') on conflict do nothing;
insert into voce (testo) values ('Chiede una descrizione della scena') on conflict do nothing;
insert into voce (testo) values ('«Colpo d''occhio»') on conflict do nothing;
insert into voce (testo) values ('Dinamica dell''evento') on conflict do nothing;
insert into voce (testo) values ('Approccio frontale, immobilizza manualmente il rachide cervicale') on conflict do nothing;
insert into voce (testo) values ('Si qualifica come soccorritore') on conflict do nothing;
insert into voce (testo) values ('Verifica pervietà delle vie aeree') on conflict do nothing;
insert into voce (testo) values ('Fa posizionare il collare cervicale') on conflict do nothing;
insert into voce (testo) values ('Fa mettere maschera O2 ad alti flussi se necessario') on conflict do nothing;
insert into voce (testo) values ('Osserva meccanica respiratoria ed espansione toracica simmetrica, uso muscoli accessori') on conflict do nothing;
insert into voce (testo) values ('Palpa delicatamente il torace') on conflict do nothing;
insert into voce (testo) values ('Ascolta rumori respiratori') on conflict do nothing;
insert into voce (testo) values ('Conta atti respiratori') on conflict do nothing;
insert into voce (testo) values ('Saturimetria') on conflict do nothing;
insert into voce (testo) values ('Osserva se emorragie esterne') on conflict do nothing;
insert into voce (testo) values ('Rileva polso radiale') on conflict do nothing;
insert into voce (testo) values ('Conta FC') on conflict do nothing;
insert into voce (testo) values ('Valuta cute e temperatura') on conflict do nothing;
insert into voce (testo) values ('Rileva PA') on conflict do nothing;
insert into voce (testo) values ('Valuta secondo AVPU') on conflict do nothing;
insert into voce (testo) values ('Pone domande idonee') on conflict do nothing;
insert into voce (testo) values ('Valuta sensibilità e motilità') on conflict do nothing;
insert into voce (testo) values ('Non spoglia completamente il paziente ma espone gli arti con sospette fratture e le zone da analizzare') on conflict do nothing;
insert into voce (testo) values ('Protezione termica') on conflict do nothing;
insert into voce (testo) values ('SAMPLE') on conflict do nothing;
insert into voce (testo) values ('OPQRST') on conflict do nothing;
insert into voce (testo) values ('Conferma dinamica') on conflict do nothing;
insert into voce (testo) values ('Stato di coscienza') on conflict do nothing;
insert into voce (testo) values ('Parametri rilevati') on conflict do nothing;
insert into voce (testo) values ('Lesioni rilevate') on conflict do nothing;
insert into voce (testo) values ('Patologie pregresse') on conflict do nothing;
insert into voce (testo) values ('Manovre eseguite') on conflict do nothing;
insert into voce (testo) values ('Rivalutazione ABCDE e monitoraggio parametri vitali') on conflict do nothing;
insert into voce (testo) values ('Relazione adeguata con il paziente') on conflict do nothing;
insert into voce (testo) values ('Utilizzo di presidi adeguati per il trasporto') on conflict do nothing;
insert into voce (testo) values ('Identifica gli errori') on conflict do nothing;
insert into voce (testo) values ('Fluidità dell''esecuzione') on conflict do nothing;
insert into voce (testo) values ('Coordinamento dell''équipe') on conflict do nothing;
insert into voce (testo) values ('Capacità di leader') on conflict do nothing;
insert into voce (testo) values ('Comunicazione efficace') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Anticipazione', 'Assegna ruoli e compiti'),
  (2, 'Autoprotezione', 'Indossa presidi di protezione individuali'),
  (3, 'Autoprotezione', 'Controlla la presenza di pericoli'),
  (4, 'Sicurezza, dinamica e quick look', 'Sicurezza'),
  (5, 'Sicurezza, dinamica e quick look', 'Chiede una descrizione della scena'),
  (6, 'Sicurezza, dinamica e quick look', '«Colpo d''occhio»'),
  (7, 'Sicurezza, dinamica e quick look', 'Dinamica dell''evento'),
  (8, 'A · Vie aeree', 'Approccio frontale, immobilizza manualmente il rachide cervicale'),
  (9, 'A · Vie aeree', 'Si qualifica come soccorritore'),
  (10, 'A · Vie aeree', 'Verifica pervietà delle vie aeree'),
  (11, 'A · Vie aeree', 'Fa posizionare il collare cervicale'),
  (12, 'A · Vie aeree', 'Fa mettere maschera O2 ad alti flussi se necessario'),
  (13, 'B · Respiro', 'Osserva meccanica respiratoria ed espansione toracica simmetrica, uso muscoli accessori'),
  (14, 'B · Respiro', 'Palpa delicatamente il torace'),
  (15, 'B · Respiro', 'Ascolta rumori respiratori'),
  (16, 'B · Respiro', 'Conta atti respiratori'),
  (17, 'B · Respiro', 'Saturimetria'),
  (18, 'C · Circolo', 'Osserva se emorragie esterne'),
  (19, 'C · Circolo', 'Rileva polso radiale'),
  (20, 'C · Circolo', 'Conta FC'),
  (21, 'C · Circolo', 'Valuta cute e temperatura'),
  (22, 'C · Circolo', 'Rileva PA'),
  (23, 'D · Controllo neurologico', 'Valuta secondo AVPU'),
  (24, 'D · Controllo neurologico', 'Pone domande idonee'),
  (25, 'D · Controllo neurologico', 'Valuta sensibilità e motilità'),
  (26, 'E · Esame obiettivo testa-piedi', 'Non spoglia completamente il paziente ma espone gli arti con sospette fratture e le zone da analizzare'),
  (27, 'E · Esame obiettivo testa-piedi', 'Protezione termica'),
  (28, 'Valutazione secondaria e dolore', 'SAMPLE'),
  (29, 'Valutazione secondaria e dolore', 'OPQRST'),
  (30, 'Comunicazione alla CO', 'Conferma dinamica'),
  (31, 'Comunicazione alla CO', 'Stato di coscienza'),
  (32, 'Comunicazione alla CO', 'Parametri rilevati'),
  (33, 'Comunicazione alla CO', 'Lesioni rilevate'),
  (34, 'Comunicazione alla CO', 'Patologie pregresse'),
  (35, 'Comunicazione alla CO', 'Manovre eseguite'),
  (36, 'Rivalutazione', 'Rivalutazione ABCDE e monitoraggio parametri vitali'),
  (37, 'Rivalutazione', 'Relazione adeguata con il paziente'),
  (38, 'Rivalutazione', 'Utilizzo di presidi adeguati per il trasporto'),
  (39, 'Valutazione del soccorso (aggiuntiva)', 'Identifica gli errori'),
  (40, 'Valutazione del soccorso (aggiuntiva)', 'Fluidità dell''esecuzione'),
  (41, 'Valutazione del soccorso (aggiuntiva)', 'Coordinamento dell''équipe'),
  (42, 'Valutazione del soccorso (aggiuntiva)', 'Capacità di leader'),
  (43, 'Valutazione del soccorso (aggiuntiva)', 'Comunicazione efficace')
) as t(n, sez, testo) where p.codice='mc-scenario-1-spinale' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia_skill (patologia_id, dopo_ordine, skill_id) select p.id, 11, s.id from patologia p, patologia s where p.codice='mc-scenario-1-spinale' and s.codice='skill-02-collare' on conflict do nothing;
insert into patologia_skill (patologia_id, dopo_ordine, skill_id) select p.id, 27, s.id from patologia p, patologia s where p.codice='mc-scenario-1-spinale' and s.codice='skill-05-pronosupinazione' on conflict do nothing;
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('mc-scenario-2-scoop', 'Mega Code – Scenario trauma 2: incidente in moto', 'MC2', 'Mega Code', 'Estrazione del casco, immobilizzazione su tavola Scoop. Scheda di valutazione per fasi (PHTC).', '{megacode}', '{}') on conflict (codice) do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Anticipazione', 'Assegna ruoli e compiti'),
  (2, 'Autoprotezione', 'Indossa presidi di protezione individuali'),
  (3, 'Autoprotezione', 'Controlla la presenza di pericoli'),
  (4, 'Sicurezza, dinamica e quick look', 'Sicurezza'),
  (5, 'Sicurezza, dinamica e quick look', 'Chiede una descrizione della scena'),
  (6, 'Sicurezza, dinamica e quick look', '«Colpo d''occhio»'),
  (7, 'Sicurezza, dinamica e quick look', 'Dinamica dell''evento'),
  (8, 'A · Vie aeree', 'Approccio frontale, immobilizza manualmente il rachide cervicale'),
  (9, 'A · Vie aeree', 'Si qualifica come soccorritore'),
  (10, 'A · Vie aeree', 'Verifica pervietà delle vie aeree'),
  (11, 'A · Vie aeree', 'Fa posizionare il collare cervicale'),
  (12, 'A · Vie aeree', 'Fa mettere maschera O2 ad alti flussi se necessario'),
  (13, 'B · Respiro', 'Osserva meccanica respiratoria ed espansione toracica simmetrica, uso muscoli accessori'),
  (14, 'B · Respiro', 'Palpa delicatamente il torace'),
  (15, 'B · Respiro', 'Ascolta rumori respiratori'),
  (16, 'B · Respiro', 'Conta atti respiratori'),
  (17, 'B · Respiro', 'Saturimetria'),
  (18, 'C · Circolo', 'Osserva se emorragie esterne'),
  (19, 'C · Circolo', 'Rileva polso radiale'),
  (20, 'C · Circolo', 'Conta FC'),
  (21, 'C · Circolo', 'Valuta cute e temperatura'),
  (22, 'C · Circolo', 'Rileva PA'),
  (23, 'D · Controllo neurologico', 'Valuta secondo AVPU'),
  (24, 'D · Controllo neurologico', 'Pone domande idonee'),
  (25, 'D · Controllo neurologico', 'Valuta sensibilità e motilità'),
  (26, 'E · Esame obiettivo testa-piedi', 'Non spoglia completamente il paziente ma espone gli arti con sospette fratture e le zone da analizzare'),
  (27, 'E · Esame obiettivo testa-piedi', 'Protezione termica'),
  (28, 'Valutazione secondaria e dolore', 'SAMPLE'),
  (29, 'Valutazione secondaria e dolore', 'OPQRST'),
  (30, 'Comunicazione alla CO', 'Conferma dinamica'),
  (31, 'Comunicazione alla CO', 'Stato di coscienza'),
  (32, 'Comunicazione alla CO', 'Parametri rilevati'),
  (33, 'Comunicazione alla CO', 'Lesioni rilevate'),
  (34, 'Comunicazione alla CO', 'Patologie pregresse'),
  (35, 'Comunicazione alla CO', 'Manovre eseguite'),
  (36, 'Rivalutazione', 'Rivalutazione ABCDE e monitoraggio parametri vitali'),
  (37, 'Rivalutazione', 'Relazione adeguata con il paziente'),
  (38, 'Rivalutazione', 'Utilizzo di presidi adeguati per il trasporto'),
  (39, 'Valutazione del soccorso (aggiuntiva)', 'Identifica gli errori'),
  (40, 'Valutazione del soccorso (aggiuntiva)', 'Fluidità dell''esecuzione'),
  (41, 'Valutazione del soccorso (aggiuntiva)', 'Coordinamento dell''équipe'),
  (42, 'Valutazione del soccorso (aggiuntiva)', 'Capacità di leader'),
  (43, 'Valutazione del soccorso (aggiuntiva)', 'Comunicazione efficace')
) as t(n, sez, testo) where p.codice='mc-scenario-2-scoop' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia_skill (patologia_id, dopo_ordine, skill_id) select p.id, 27, s.id from patologia p, patologia s where p.codice='mc-scenario-2-scoop' and s.codice='skill-10-casco' on conflict do nothing;
insert into patologia_skill (patologia_id, dopo_ordine, skill_id) select p.id, 27, s.id from patologia p, patologia s where p.codice='mc-scenario-2-scoop' and s.codice='skill-14-scoop-2020' on conflict do nothing;
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('mc-scenario-3-xt', 'Mega Code – Scenario trauma 3: auto contro albero', 'MC3', 'Mega Code', 'Estricazione cautelativa con XT. Scheda di valutazione per fasi (PHTC).', '{megacode}', '{}') on conflict (codice) do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Anticipazione', 'Assegna ruoli e compiti'),
  (2, 'Autoprotezione', 'Indossa presidi di protezione individuali'),
  (3, 'Autoprotezione', 'Controlla la presenza di pericoli'),
  (4, 'Sicurezza, dinamica e quick look', 'Sicurezza'),
  (5, 'Sicurezza, dinamica e quick look', 'Chiede una descrizione della scena'),
  (6, 'Sicurezza, dinamica e quick look', '«Colpo d''occhio»'),
  (7, 'Sicurezza, dinamica e quick look', 'Dinamica dell''evento'),
  (8, 'A · Vie aeree', 'Approccio frontale, immobilizza manualmente il rachide cervicale'),
  (9, 'A · Vie aeree', 'Si qualifica come soccorritore'),
  (10, 'A · Vie aeree', 'Verifica pervietà delle vie aeree'),
  (11, 'A · Vie aeree', 'Fa posizionare il collare cervicale'),
  (12, 'A · Vie aeree', 'Fa mettere maschera O2 ad alti flussi se necessario'),
  (13, 'B · Respiro', 'Osserva meccanica respiratoria ed espansione toracica simmetrica, uso muscoli accessori'),
  (14, 'B · Respiro', 'Palpa delicatamente il torace'),
  (15, 'B · Respiro', 'Ascolta rumori respiratori'),
  (16, 'B · Respiro', 'Conta atti respiratori'),
  (17, 'B · Respiro', 'Saturimetria'),
  (18, 'C · Circolo', 'Osserva se emorragie esterne'),
  (19, 'C · Circolo', 'Rileva polso radiale'),
  (20, 'C · Circolo', 'Conta FC'),
  (21, 'C · Circolo', 'Valuta cute e temperatura'),
  (22, 'C · Circolo', 'Rileva PA'),
  (23, 'D · Controllo neurologico', 'Valuta secondo AVPU'),
  (24, 'D · Controllo neurologico', 'Pone domande idonee'),
  (25, 'D · Controllo neurologico', 'Valuta sensibilità e motilità'),
  (26, 'E · Esame obiettivo testa-piedi', 'Non spoglia completamente il paziente ma espone gli arti con sospette fratture e le zone da analizzare'),
  (27, 'E · Esame obiettivo testa-piedi', 'Protezione termica'),
  (28, 'Valutazione secondaria e dolore', 'SAMPLE'),
  (29, 'Valutazione secondaria e dolore', 'OPQRST'),
  (30, 'Comunicazione alla CO', 'Conferma dinamica'),
  (31, 'Comunicazione alla CO', 'Stato di coscienza'),
  (32, 'Comunicazione alla CO', 'Parametri rilevati'),
  (33, 'Comunicazione alla CO', 'Lesioni rilevate'),
  (34, 'Comunicazione alla CO', 'Patologie pregresse'),
  (35, 'Comunicazione alla CO', 'Manovre eseguite'),
  (36, 'Rivalutazione', 'Rivalutazione ABCDE e monitoraggio parametri vitali'),
  (37, 'Rivalutazione', 'Relazione adeguata con il paziente'),
  (38, 'Rivalutazione', 'Utilizzo di presidi adeguati per il trasporto'),
  (39, 'Valutazione del soccorso (aggiuntiva)', 'Identifica gli errori'),
  (40, 'Valutazione del soccorso (aggiuntiva)', 'Fluidità dell''esecuzione'),
  (41, 'Valutazione del soccorso (aggiuntiva)', 'Coordinamento dell''équipe'),
  (42, 'Valutazione del soccorso (aggiuntiva)', 'Capacità di leader'),
  (43, 'Valutazione del soccorso (aggiuntiva)', 'Comunicazione efficace')
) as t(n, sez, testo) where p.codice='mc-scenario-3-xt' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia_skill (patologia_id, dopo_ordine, skill_id) select p.id, 27, s.id from patologia p, patologia s where p.codice='mc-scenario-3-xt' and s.codice='skill-15-xt' on conflict do nothing;
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie, errori_gravi) values ('mc-scenario-4-ictus', 'Mega Code – Scenario medico 4: sospetto ictus', 'MC4', 'Mega Code', 'Sedia cardiologica, caricamento su barella autocaricante. Scheda di valutazione per fasi (PHTC).', '{megacode}', '{}') on conflict (codice) do nothing;
insert into voce (testo) values ('Approccio frontale') on conflict do nothing;
insert into voce (testo) values ('FAST / Cincinnati') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, t.sez, (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Anticipazione', 'Assegna ruoli e compiti'),
  (2, 'Autoprotezione', 'Indossa presidi di protezione individuali'),
  (3, 'Autoprotezione', 'Controlla la presenza di pericoli'),
  (4, 'Sicurezza, dinamica e quick look', 'Sicurezza'),
  (5, 'Sicurezza, dinamica e quick look', 'Chiede una descrizione della scena'),
  (6, 'Sicurezza, dinamica e quick look', '«Colpo d''occhio»'),
  (7, 'Sicurezza, dinamica e quick look', 'Dinamica dell''evento'),
  (8, 'A · Vie aeree', 'Approccio frontale'),
  (9, 'A · Vie aeree', 'Si qualifica come soccorritore'),
  (10, 'A · Vie aeree', 'Verifica pervietà delle vie aeree'),
  (11, 'B · Respiro', 'Osserva meccanica respiratoria ed espansione toracica simmetrica, uso muscoli accessori'),
  (12, 'B · Respiro', 'Palpa delicatamente il torace'),
  (13, 'B · Respiro', 'Ascolta rumori respiratori'),
  (14, 'B · Respiro', 'Conta atti respiratori'),
  (15, 'B · Respiro', 'Saturimetria'),
  (16, 'C · Circolo', 'Osserva se emorragie esterne'),
  (17, 'C · Circolo', 'Rileva polso radiale'),
  (18, 'C · Circolo', 'Conta FC'),
  (19, 'C · Circolo', 'Valuta cute e temperatura'),
  (20, 'C · Circolo', 'Rileva PA'),
  (21, 'D · Controllo neurologico', 'Valuta secondo AVPU'),
  (22, 'D · Controllo neurologico', 'Pone domande idonee'),
  (23, 'D · Controllo neurologico', 'Valuta sensibilità e motilità'),
  (24, 'D · Controllo neurologico', 'FAST / Cincinnati'),
  (25, 'E · Esame obiettivo testa-piedi', 'Non spoglia completamente il paziente ma espone gli arti con sospette fratture e le zone da analizzare'),
  (26, 'E · Esame obiettivo testa-piedi', 'Protezione termica'),
  (27, 'Valutazione secondaria e dolore', 'SAMPLE'),
  (28, 'Comunicazione alla CO', 'Conferma dinamica'),
  (29, 'Comunicazione alla CO', 'Stato di coscienza'),
  (30, 'Comunicazione alla CO', 'Parametri rilevati'),
  (31, 'Comunicazione alla CO', 'Lesioni rilevate'),
  (32, 'Comunicazione alla CO', 'Patologie pregresse'),
  (33, 'Comunicazione alla CO', 'Manovre eseguite'),
  (34, 'Rivalutazione', 'Rivalutazione ABCDE e monitoraggio parametri vitali'),
  (35, 'Rivalutazione', 'Relazione adeguata con il paziente'),
  (36, 'Rivalutazione', 'Utilizzo di presidi adeguati per il trasporto'),
  (37, 'Valutazione del soccorso (aggiuntiva)', 'Identifica gli errori'),
  (38, 'Valutazione del soccorso (aggiuntiva)', 'Fluidità dell''esecuzione'),
  (39, 'Valutazione del soccorso (aggiuntiva)', 'Coordinamento dell''équipe'),
  (40, 'Valutazione del soccorso (aggiuntiva)', 'Capacità di leader'),
  (41, 'Valutazione del soccorso (aggiuntiva)', 'Comunicazione efficace')
) as t(n, sez, testo) where p.codice='mc-scenario-4-ictus' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia_skill (patologia_id, dopo_ordine, skill_id) select p.id, 26, s.id from patologia p, patologia s where p.codice='mc-scenario-4-ictus' and s.codice='skill-12-sedia-portantina' on conflict do nothing;
