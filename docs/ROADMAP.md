# Roadmap (3–4 mesi)

**Fatto in questo scheletro:** schema, importer Excel, PDF schede (vuote/compilate), API con ruoli, sync idempotente, classifiche, monitor, inserimento rapido responsive, interfaccia di gestione (eventi, squadre, scene, libreria, utenti, assegnazioni), 36 test, due giri di revisione indipendente del codice con correzioni.

| Fase | Contenuto | Stima |
|---|---|---|
| 1 | Hosting + HTTPS + backup; login sicuro (limite tentativi, cambio password) | 1–2 sett. |
| 2 | Rifinitura gestione: import/export libreria, riordino scene, anteprima scheda PDF dalla UI | 1–2 sett. |
| 3 | Rifinitura inserimento (verifica/riapertura, parametri simulatore, filtri), monitor live, classifiche con percentuali ed export Excel | 3 sett. |
| 4 | Stampa: selezione scena/squadre, schede compilate per squadra, riepilogo finale; prova su gara reale in parallelo alla carta | 2 sett. |
| 5 | Anagrafica partecipanti e verifica requisiti (da definire i requisiti) | 2–3 sett. |
| 6 | Offline: service worker, IndexedDB, coda di sync, schermata conflitti | 3 sett. |
| — | Migrazione storico dalle liste SharePoint (l'importer legge il formato Excel; per SharePoint serve l'export) | 1 sett. |

Le stime sono indicative, non misurate.

## Da decidere / verificare
1. Hosting gratuito scelto e sue condizioni attuali.
2. Regola di conflitto offline: ora vince l'ultima modifica per voce; se due giudici compilano la stessa scheda serve un avviso.
3. Chi può "verificare" e se la verifica è obbligatoria prima della classifica.
4. Classifica Master/Leader: ora = scheda con `is_master`; confermare con il regolamento.
5. PDF: logo estratto dal PDF attuale, Calibri sostituito da Helvetica, icone dei livelli disegnate in vettoriale.
6. Il file di test `api/test/fixtures/scena-alfa.xlsx` contiene squadre e punteggi reali (e i nomi di prova "Peter Griffin"): sostituirlo con dati fittizi prima di pubblicare il repository.
7. Font dei PDF: Liberation Sans incorporato (licenza OFL, file in `assets/fonts`); testi troppo lunghi vengono rimpiccioliti e poi troncati con «…». Il testo lungo va a capo (max 3 righe) e il carattere si riduce fino a 6,5 pt; una scheda con più di 62 righe viene rifiutata già alla composizione della scena (serve la gestione su più pagine).
8. Da decidere: la classifica è visibile anche ai giudici durante la gara; l'organizzazione può modificare una scheda verificata senza riaprirla (resta traccia in audit); classifica "ufficiale" solo con schede completate; limite tentativi di login valido per un solo processo.
9. Prima della gara: prova generale su più tablet (online e con rete interrotta), HTTPS, backup `pg_dump`.
10. Nel vecchio Excel la scheda "Agitata" (Giudice 5) compare in DATI ma non ha voci: l'importer la salta e segnala l'avviso.
