# Architettura

## 1. Modello dati a 3 livelli (risolve il problema "un Excel per ogni scena")

```
LIBRERIA (riusabile)                 EVENTO (storicizzato)
 voce ──┐                              evento ─┬─ squadra ── squadra_membro ── partecipante
        ├─ patologia_voce ── patologia │        └─ scena ── scena_scheda ── scena_scheda_voce (COPIA)
 scala_punteggio ┘ (override per voce)  │
                                      compilazione (squadra × scheda) ── risposta (una riga per voce)
```

* **voce**: il testo ("indossa i d.p.i. in scena"), scritto una volta sola.
* **scala_punteggio**: Standard 5/4/2/1/0, 3 Voci 3/–/1/–/0, PesoDoppio 10/8/4/1/0, Binario Punitivo 0/–/–/–/–50. Un livello `NULL` = cella nera in stampa e pulsante disabilitato in inserimento (sostituisce i flag `Has_MB…Has_NE`, che nel vecchio sistema dovevano essere tenuti allineati a mano).
* **patologia**: elenco ordinato di voci; **la scala è sul legame voce↔patologia**, quindi la stessa voce può valere 5 in una patologia e 10 in un'altra.
* **scena_scheda**: una patologia inserita in una scena (slot, simulatore, parametri FR/FC/coscienza/cute).
* **scena_scheda_voce**: **copia** delle voci con i punteggi già risolti. Modificare la libreria non cambia le gare passate (c'è un test). Si può personalizzare una voce solo per quella scena (`PUT /api/schede/:id/voci/:ordine`).
* **Template**: `POST /api/scene/:id/duplica` copia una scena (schede e voci) in un altro evento.
* **compilazione**: stato `bozza → completata → verificata`, origine `carta | tablet_online | tablet_offline`, vincolo `unique(scheda, squadra)`.
* **risposta**: una riga per voce; il punteggio **non è salvato**, si calcola dalla voce (viste `v_punti_voce`, `v_classifica`). Cambiando un punteggio la classifica si ricalcola senza riscrivere nulla.

Classifiche: Generale, SEP (voci `is_sep`), BLS (schede `is_bls`), Master (scheda `is_master`). Massimi teorici in `v_massimi_evento`.

## 2. Le tre modalità di compilazione

| Modalità | Come |
|---|---|
| Carta + trascrizione | PDF schede vuote → compilazione a mano → l'organizzazione inserisce con la stessa schermata (origine `carta`). La carta resta prova/backup. |
| Tablet online | stessa schermata, salvataggio automatico ogni 600 ms su `POST /api/sync`. |
| Tablet offline (fase 2) | già predisposto: UUID generati dal client, coda locale (nel prototipo in `localStorage`), upsert idempotente. Manca il service worker e lo storage IndexedDB. |

**Regole di sincronizzazione** (`services/compilazioni.js`, coperte da test): ritrasmettere lo stesso payload non crea duplicati; per ogni voce vince `updated_at` più recente; lo stato non retrocede; una scheda verificata non è modificabile dai giudici; solo organizzazione/admin verifica e riapre; i livelli non consentiti vengono rifiutati dal server.

## 3. Ruoli
* **giudice**: vede solo le schede a lui assegnate (`assegnazione`), compila e completa.
* **organizzazione**: tutto sull'evento (squadre, scene, stampa, verifica, riapertura, trascrizione).
* **admin**: come organizzazione + gestione utenti (creazione, ruolo, password, disattivazione). La libreria (voci, scale, patologie) è modificabile anche dall'organizzazione.

### Giudice master e visibilità dei punti
* **giudice master** (`giudice_master`): assegnato a una o più **scene** (Gestione → Scene → «Giudice master…»). Vede e può correggere **tutte** le schede della sua scena, le **verifica/chiude** («Verifica e chiudi») e può riaprirle. Le sue scritture prevalgono su quelle dei giudici; ogni correzione a una scheda compilata da altri finisce nel registro modifiche (`audit_log`, azione `correzione_master`, voce per voce: prima → dopo).
* Flusso con i tablet: il giudice compila e preme «Completa» (se mancano voci, vengono evidenziate in rosso e chiede conferma); la scheda resta **«in attesa»**; il master la verifica e la chiude. Una scheda chiusa è di sola lettura per i giudici.
* **Chi inserisce i dati non vede mai i punti**: il server non invia i valori ai giudici (solo i livelli consentiti), né la libreria delle scale, né classifica e monitor.
* **Anagrafica** (scheda «Persone», solo organizzazione/admin): cognome, nome, data di nascita, codice fiscale (facoltativo), email, comitato, provincia, note. Le squadre hanno un **comitato** e i **componenti** (da anagrafica, anche di comitati diversi).

## 3b. Interfaccia di gestione (`web/admin.html`)
Schede: **Evento** (crea, modifica, attiva, archivia, stampa PDF per scena/squadre), **Squadre** (aggiungi, rinomina, disattiva), **Scene e schede** (crea scena, aggiungi scheda da patologia, parametri simulatore, punteggi e SEP per singola voce solo per quella scena, assegnazione giudici, duplica in un altro evento, elimina se senza valutazioni), **Libreria** (editor patologie con riordino voci, scale di punteggio), **Utenti** (solo admin). Eliminare una scena/scheda con valutazioni già inserite è bloccato dal server.

## 4. PDF
Generati sul server con la stessa griglia della scheda attuale (`api/src/pdf/scheda.js`). `GET /api/eventi/:id/stampa.pdf?vuote=1|0&scena=A&squadra=1,2`. Un solo file con tutte le schede, ordinate squadra → scena → slot. Esempi in `docs/esempi/`. Niente Excel, Office Script o Power Automate.

## 5. Cosa corregge rispetto alla versione Power Apps
* Classifica non più limitata a 2000 righe per scena né a scene A–F fisse (query SQL aggregata).
* Punteggio SEP derivato dalla voce, non copiato in ogni risposta: nei dati reali Carpineti risultava 154 contro 90 (17 risposte avevano il flag SEP diverso da quello attuale della voce; il flag viene copiato in ogni riga al momento dell'inserimento).
* Percentuale sul massimo teorico funzionante (il vecchio foglio dava sempre 0).
* Un solo evento attivo; numero squadra mai riusato; nessuna doppia compilazione per la stessa scheda; errori di salvataggio mostrati, non nascosti.
* Modello senza cancellazioni fisiche delle risposte (le squadre si disattivano).

## 6. Hosting (da verificare prima di scegliere)
Il codice gira su qualsiasi Postgres + Node. Per costo zero va verificato, al momento della scelta, cosa offrono davvero i piani gratuiti (limiti di spazio, sospensione per inattività, backup): non ho verificato le condizioni attuali. Alternativa: un piccolo server proprio con backup periodico. Qualunque scelta richiede un backup giornaliero (`pg_dump`) e un export prima di ogni gara.

## 7. Sicurezza (stato attuale, dopo la revisione indipendente)
* Password con scrypt; token firmato (12 h) che contiene solo l'id: **ruolo e stato attivo vengono riletti dal DB a ogni richiesta**, quindi disattivare o declassare un utente ha effetto immediato.
* Il server **non parte senza `JWT_SECRET` di almeno 32 caratteri**.
* Autenticazione sul pattern della rotta (non sull'URL grezzo); ruoli verificati lato server; il giudice accede solo alle schede assegnate (lettura e scrittura).
* Limite ai tentativi di login (8 errori ogni 15 minuti per IP+email, in memoria: valido per un solo processo) e tempo di risposta uniforme per email inesistenti.
* Il PDF si scarica con l'intestazione `Authorization`; il token **non è più accettato nell'indirizzo**.
* Escape dell'output nelle pagine web, intestazioni CSP/nosniff/no-referrer, validazione di codici e payload.
* Integrità: chiavi esterne `restrict` su compilazioni/risposte (nessuna cancellazione a cascata di valutazioni), un solo evento attivo imposto dal DB, vincolo "almeno un livello" sulle voci, sincronizzazione a blocchi in un'unica transazione.
* Audit: modifica di punteggi di una voce, riapertura, modifica di organizzazione/admin su schede completate o verificate.

**Ancora da fare prima dell'uso reale:** HTTPS (lo fornisce l'hosting), backup `pg_dump` prima e dopo ogni gara, cambio password da parte dell'utente, limite tentativi condiviso se si usa più di un processo, valutare se il giudice deve vedere la classifica durante la gara (oggi la vede), e una vista "classifica ufficiale" che conti solo schede completate/verificate (oggi la classifica include anche le bozze, utile come live).

**Regole di conflitto (sync):**
* per ogni voce: le scritture di **organizzazione/admin prevalgono sul giudice** (anche con orario più vecchio: è una scelta, una trascrizione dalla carta o una correzione dell'organizzazione vale più di un tocco del giudice); dentro la stessa categoria vince la più recente;
* l'orario del dispositivo è limitato all'orario del server (un tablet con data sbagliata non blocca le correzioni);
* l'annullo di una risposta (ri-tocco della stessa scelta) è registrato come riga con livello nullo: un dato vecchio che arriva dopo non lo fa risorgere;
* i batch sono elaborati in un ordine fisso e in un'unica transazione (con nuovi tentativi in caso di deadlock);
* il nome del giudice stampato è quello dell'account (solo l'organizzazione può indicarne un altro, per le trascrizioni).

## 8. Coda del client (`web/coda.js`, 8 test)
Ogni tocco è scritto subito su disco; dopo un invio riuscito si cancella solo ciò che è stato inviato e non è cambiato nel frattempo; gli invii sono serializzati (un "Completa" durante un invio non va perso); senza rete o con errori 5xx/401/429 i dati restano; gli errori 4xx definitivi spostano i dati tra le **rifiutate** (visibili in Home, ripristinabili) invece di cancellarli; un id in conflitto viene rigenerato; il logout non svuota la coda e ogni utente ha la sua.

## 9. Database esistente e migrazioni
`node tools/db-init.js` crea lo schema su un database vuoto; su un database già esistente applica solo le migrazioni mancanti in `db/migrazioni/` (idempotenti, registrate in `schema_migrazioni`). `--reset` cancella tutto: solo per sviluppo.
