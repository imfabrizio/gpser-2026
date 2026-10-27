-- Skill: fasce di giudizio automatiche (75/80/85/95%, calcolate sul numero di voci) e Barella Scoop in due schede (trasporto, semi-verticalizzazione).
-- Le fasce fisse delle skill di esame inserite in origine vengono tolte: da ora si calcolano. Le sessioni già svolte conservano la loro copia.
update patologia set fasce = null where categoria = 'Esame TSSA';
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie) values ('skill-scoop-trasporto', 'Skill – Barella Scoop (cinghiaggio da trasporto)', 'SCT', 'Esame TSSA', 'Barella Scoop, cinghiaggio da trasporto. Minimo 10 voci, una per gesto indipendente; fasce automatiche. Errori gravi: passare sopra al paziente; non assicurare il paziente al presidio; lasciare il capo prima del montaggio della cintura H.', '{skill,megacode}') on conflict (codice) do nothing;
insert into voce (testo) values ('Mantiene sempre il capo (il soccorritore di testa non lascia la presa fino al montaggio della cintura H)') on conflict do nothing;
insert into voce (testo) values ('Posiziona il cuscino e la base fermacapo sotto la testa') on conflict do nothing;
insert into voce (testo) values ('Monta i fermacapi con frontale e mentoniera') on conflict do nothing;
insert into voce (testo) values ('Posiziona la barella di fianco al paziente') on conflict do nothing;
insert into voce (testo) values ('Prende la misura corretta della barella (due soccorritori)') on conflict do nothing;
insert into voce (testo) values ('Allontana la barella dal paziente prima di aprirla') on conflict do nothing;
insert into voce (testo) values ('Apre la barella partendo dai piedi e poi dalla testa') on conflict do nothing;
insert into voce (testo) values ('Porta una valva al lato opposto senza passare sopra al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona la prima valva sotto al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona la seconda valva sotto al paziente senza urtare la testa') on conflict do nothing;
insert into voce (testo) values ('Chiude la barella prima dalla testa e poi dai piedi') on conflict do nothing;
insert into voce (testo) values ('Verifica la corretta chiusura della barella alla testa e ai piedi') on conflict do nothing;
insert into voce (testo) values ('Applica le cinture toraciche a X (1sx-3dx e 1dx-3sx)') on conflict do nothing;
insert into voce (testo) values ('Applica la cintura al bacino (3 con 3)') on conflict do nothing;
insert into voce (testo) values ('Applica la cintura ai piedi (otto)') on conflict do nothing;
insert into voce (testo) values ('Monta la cintura H (dopo l''ultima cintura dei piedi)') on conflict do nothing;
insert into voce (testo) values ('Verifica la posizione di tutte le cinture') on conflict do nothing;
insert into voce (testo) values ('Coordina il posizionamento dei soccorritori') on conflict do nothing;
insert into voce (testo) values ('Esegue la prova di sollevamento in modo sincrono con l''altro operatore') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Mantiene sempre il capo (il soccorritore di testa non lascia la presa fino al montaggio della cintura H)'),
  (2, 'Posiziona il cuscino e la base fermacapo sotto la testa'),
  (3, 'Monta i fermacapi con frontale e mentoniera'),
  (4, 'Posiziona la barella di fianco al paziente'),
  (5, 'Prende la misura corretta della barella (due soccorritori)'),
  (6, 'Allontana la barella dal paziente prima di aprirla'),
  (7, 'Apre la barella partendo dai piedi e poi dalla testa'),
  (8, 'Porta una valva al lato opposto senza passare sopra al paziente'),
  (9, 'Posiziona la prima valva sotto al paziente'),
  (10, 'Posiziona la seconda valva sotto al paziente senza urtare la testa'),
  (11, 'Chiude la barella prima dalla testa e poi dai piedi'),
  (12, 'Verifica la corretta chiusura della barella alla testa e ai piedi'),
  (13, 'Applica le cinture toraciche a X (1sx-3dx e 1dx-3sx)'),
  (14, 'Applica la cintura al bacino (3 con 3)'),
  (15, 'Applica la cintura ai piedi (otto)'),
  (16, 'Monta la cintura H (dopo l''ultima cintura dei piedi)'),
  (17, 'Verifica la posizione di tutte le cinture'),
  (18, 'Coordina il posizionamento dei soccorritori'),
  (19, 'Esegue la prova di sollevamento in modo sincrono con l''altro operatore')
) as t(n, testo)
where p.codice='skill-scoop-trasporto' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
insert into patologia (codice, nome, sigla, categoria, descrizione, tipologie) values ('skill-scoop-semiverticale', 'Skill – Barella Scoop (cinghiaggio da semi-verticalizzazione)', 'SCV', 'Esame TSSA', 'Barella Scoop, cinghiaggio da semi-verticalizzazione. Minimo 10 voci, una per gesto indipendente; fasce automatiche. Errori gravi: passare sopra al paziente; non assicurare il paziente al presidio; lasciare il capo prima del montaggio della cintura H.', '{skill,megacode}') on conflict (codice) do nothing;
insert into voce (testo) values ('Mantiene sempre il capo (il soccorritore di testa non lascia la presa fino al montaggio della cintura H)') on conflict do nothing;
insert into voce (testo) values ('Posiziona il cuscino e la base fermacapo sotto la testa') on conflict do nothing;
insert into voce (testo) values ('Monta i fermacapi con frontale e mentoniera') on conflict do nothing;
insert into voce (testo) values ('Posiziona la barella di fianco al paziente') on conflict do nothing;
insert into voce (testo) values ('Prende la misura corretta della barella (due soccorritori)') on conflict do nothing;
insert into voce (testo) values ('Allontana la barella dal paziente prima di aprirla') on conflict do nothing;
insert into voce (testo) values ('Apre la barella partendo dai piedi e poi dalla testa') on conflict do nothing;
insert into voce (testo) values ('Porta una valva al lato opposto senza passare sopra al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona la prima valva sotto al paziente') on conflict do nothing;
insert into voce (testo) values ('Posiziona la seconda valva sotto al paziente senza urtare la testa') on conflict do nothing;
insert into voce (testo) values ('Chiude la barella prima dalla testa e poi dai piedi') on conflict do nothing;
insert into voce (testo) values ('Verifica la corretta chiusura della barella alla testa e ai piedi') on conflict do nothing;
insert into voce (testo) values ('Applica la cintura toracica sottoascellare (1 con 1)') on conflict do nothing;
insert into voce (testo) values ('Applica le cinture inguinali a imbragatura (2 con 2, da entrambi i lati)') on conflict do nothing;
insert into voce (testo) values ('Applica la cintura ai piedi (otto)') on conflict do nothing;
insert into voce (testo) values ('Monta la cintura H (dopo l''ultima cintura dei piedi)') on conflict do nothing;
insert into voce (testo) values ('Verifica la posizione di tutte le cinture') on conflict do nothing;
insert into voce (testo) values ('Coordina il posizionamento dei soccorritori') on conflict do nothing;
insert into voce (testo) values ('Esegue la prova di sollevamento in modo sincrono con l''altro operatore') on conflict do nothing;
insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id)
select p.id, t.n, 'Valutazione tecnica', (select id from voce where lower(testo)=lower(t.testo)), (select id from scala_punteggio where codice='Esame 0-1-2')
from patologia p, (values
  (1, 'Mantiene sempre il capo (il soccorritore di testa non lascia la presa fino al montaggio della cintura H)'),
  (2, 'Posiziona il cuscino e la base fermacapo sotto la testa'),
  (3, 'Monta i fermacapi con frontale e mentoniera'),
  (4, 'Posiziona la barella di fianco al paziente'),
  (5, 'Prende la misura corretta della barella (due soccorritori)'),
  (6, 'Allontana la barella dal paziente prima di aprirla'),
  (7, 'Apre la barella partendo dai piedi e poi dalla testa'),
  (8, 'Porta una valva al lato opposto senza passare sopra al paziente'),
  (9, 'Posiziona la prima valva sotto al paziente'),
  (10, 'Posiziona la seconda valva sotto al paziente senza urtare la testa'),
  (11, 'Chiude la barella prima dalla testa e poi dai piedi'),
  (12, 'Verifica la corretta chiusura della barella alla testa e ai piedi'),
  (13, 'Applica la cintura toracica sottoascellare (1 con 1)'),
  (14, 'Applica le cinture inguinali a imbragatura (2 con 2, da entrambi i lati)'),
  (15, 'Applica la cintura ai piedi (otto)'),
  (16, 'Monta la cintura H (dopo l''ultima cintura dei piedi)'),
  (17, 'Verifica la posizione di tutte le cinture'),
  (18, 'Coordina il posizionamento dei soccorritori'),
  (19, 'Esegue la prova di sollevamento in modo sincrono con l''altro operatore')
) as t(n, testo)
where p.codice='skill-scoop-semiverticale' and not exists (select 1 from patologia_voce x where x.patologia_id=p.id);
