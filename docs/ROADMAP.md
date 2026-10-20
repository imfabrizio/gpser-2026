# Roadmap (3–4 mesi)

**Fatto dopo le prime prove (ottobre 2026):** valutazione senza punti visibili, pulsanti con testo per esteso, ruolo giudice master (verifica e chiude la scena), anagrafica persone con comitato/provincia, comitato e componenti delle squadre, avvio automatico di schema e migrazioni, completamento scheda bloccato se mancano voci, memoria dell'ultima selezione, colori dal verde al rosso, scheda Importa (Gestione) per caricare i file Excel delle scene gara e Olimpiadi nella libreria (patologie chiamate «<Tipo> · Gara|Olimpiadi <Scena>»); Home con gara in corso, avvisi e menu gare per l'organizzazione, utente legato a una gara, menu Gestione a pulsanti (Gara, Scene, Schede, Squadre, Anagrafiche, Classifiche, Stampa), schede raggruppate per patologia con seconda patologia, copia da modello, aggiunta voce per sezione, classifiche separate (Generale, SEP, BLSD, Master, DIU); pagina pubblica senza login (logo CRI, prossime edizioni, notizie, percorso gara con Google Maps), sezione Notizie, indirizzi/coordinate delle scene e mappa My Maps per gara, navigazione a pulsanti in Gestione, nome squadra nel banner della scheda, pulsanti di valutazione bianchi con contorno nero.

**Richieste in coda:** accesso con Google/Microsoft/Facebook e autenticazione a due fattori (progetto a parte: registrazione dell'app presso i provider, collegamento account↔persona); importazione delle gare passate come libreria di patologie e scene (servono i file); collegamento persona↔utente; registro modifiche consultabile da interfaccia.

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

11. Da confermare: cosa significa la classifica «DIU» (ora è un'etichetta assegnabile alle schede, come BLSD). Aggiungere la voce direttamente dentro una scheda già in una scena (oggi si modificano solo i punteggi; le voci nuove si aggiungono nella scheda in libreria e poi si rimette in scena).
