# Messa online: Neon (database) + Render (server), gratuiti

Condizioni dei piani gratuiti: verificale sui siti prima di affidarti (cambiano). Al momento della scelta risultava: Neon sospende il database dopo 5 minuti di inattività (riparte da solo in pochi secondi); Render ferma il servizio dopo 15 minuti senza richieste (primo accesso ~1 minuto) e il suo Postgres gratuito scade, quindi si usa Neon.

## 1. Database su Neon
1. Crea un progetto su neon.com (regione Europa, Postgres 16).
2. Copia l'indirizzo di connessione (**Connection string**, con password). Deve terminare con `?sslmode=require`. Usa quello *non pooled* se Neon ne mostra due.

## 2. Crea lo schema e il primo utente
Il server, all'avvio, **crea lo schema se il database è vuoto e applica da solo le migrazioni mancanti** (disattivabile con `AUTO_MIGRAZIONI=0`). Il primo utente amministratore va creato a mano: o con il comando qui sotto, o incollando nell'SQL Editor di Neon il file `neon-installazione.sql` fornito a parte.
```bash
git clone <il-tuo-repository> && cd garecri && npm ci
export DATABASE_URL='postgresql://...neon.tech/neondb?sslmode=require'
npm run db:init
node tools/crea-utente.js tu@esempio.it "Nome Cognome" admin UnaPasswordLunga
```
(Facoltativo, per provare con dati reali: `node tools/import-excel.js <file.xlsx> --codice ... --luogo ... --data ...`.)

## 3. Server su Render
1. Carica il progetto su GitHub (**privato**: contiene dati di prova; vedi ROADMAP punto 6).
2. Render → New → Blueprint → scegli il repository: legge `render.yaml`.
3. Quando richiesto, incolla `DATABASE_URL` (stesso indirizzo di Neon). `JWT_SECRET` lo genera Render; `TRUST_PROXY=1` è già impostato.
4. A fine deploy apri l'indirizzo `https://garecri-xxxx.onrender.com`: l'HTTPS è incluso. Controllo: `/salute` deve rispondere `{"ok":true}`.

Se non usi il Blueprint: Web Service, Build `npm ci`, Start `npm start`, Health check `/salute`, stesse variabili.

## 4. Il giorno della gara
* Apri l'app **10 minuti prima** su un dispositivo per svegliare server e database.
* Backup prima e dopo: `DATABASE_URL=... tools/backup.sh` (serve `pg_dump` con versione uguale o superiore a quella di Neon). Ripristino: `gunzip -c file.sql.gz | psql "$DATABASE_URL"`.
* Neon gratuito conserva solo poche ore di cronologia: il backup è il tuo vero salvataggio.
* Il login ha un limite tentativi in memoria: dopo un riavvio del server si azzera (accettabile con un solo processo).

## Problemi tipici
| Sintomo | Causa |
|---|---|
| `JWT_SECRET ... almeno 32 caratteri` all'avvio | variabile mancante/corta |
| errore SSL / `no pg_hba.conf entry` | manca `?sslmode=require` |
| primo caricamento lentissimo | servizio o database in risveglio |
| `/salute` 500 | `DATABASE_URL` errato o database non raggiungibile |

## 5. Accesso con Google / Microsoft e MFA
Gli utenti restano quelli creati da Gestione → Utenti: **chi non è registrato non entra**, nemmeno con un account Google/Microsoft valido. Al primo accesso la email del provider viene collegata all'utente con la stessa email. Per chi usa solo i provider, spunta «Solo accesso Google/Microsoft» alla creazione (la password è casuale e non serve).

Il pulsante compare in login solo se le variabili sono impostate su Render (poi riavvia il servizio). `PUBLIC_URL` = indirizzo dell'app, senza `/` finale.

**Google**: console.cloud.google.com → API e servizi → Schermata consenso OAuth (tipo Esterno, anche in «Test» con i tuoi utenti) → Credenziali → Crea ID client OAuth → *Applicazione web*. URI di reindirizzamento: `PUBLIC_URL/api/auth/google/callback`. Copia ID e segreto in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

**Microsoft**: entra.microsoft.com → Applicazioni → Registrazioni app → Nuova registrazione (*solo questa directory*). URI di reindirizzamento (Web): `PUBLIC_URL/api/auth/microsoft/callback`. Da «Panoramica» copia *ID applicazione* in `MS_CLIENT_ID` e *ID directory (tenant)* in `MS_TENANT` (serve il GUID, non «common»: con tenant aperti le email non sono verificabili). In «Certificati e segreti» crea un segreto client → `MS_CLIENT_SECRET` (usa il *Valore*, che scade: annota la data).

**MFA (TOTP)**: ogni utente la attiva da «Sicurezza» (QR per Microsoft/Google Authenticator + 8 codici di recupero monouso). È **obbligatoria per organizzazione e admin** quando entrano con password (disattivabile con `MFA_ORG=0`). Con Google/Microsoft si considera valida la MFA del provider (per richiederla anche lì: `SSO_RICHIEDE_MFA=1`). Se un utente perde telefono e codici: Gestione → Utenti → «Reset MFA» (solo admin). Il segreto TOTP è cifrato nel database con una chiave derivata da `JWT_SECRET`: cambiarlo invalida le MFA già configurate.

Se l'**unico admin** perde telefono e codici di recupero, si azzera dal database (SQL Editor di Neon): `update utente set mfa_attiva=false, mfa_secret=null, mfa_recupero='{}' where email='tua@email';` — al login successivo la MFA va riconfigurata.

## 6. Richieste di accesso e notifica email

Chi entra con Google/Microsoft senza essere registrato vede un modulo (nome, cognome, codice fiscale, comitato, provincia, ruolo, squadra).
La richiesta compare in **Gestione → Richieste** (solo admin), con un contatore rosso; si approva scegliendo il ruolo oppure si rifiuta.
Senza risposta entro 48 ore viene cancellata. Il codice fiscale è cifrato nel database con una chiave derivata da `JWT_SECRET`: cambiarlo rende illeggibili i codici già salvati.

Email di avviso (facoltativa, servizio gratuito Resend): crea un account su resend.com, genera una API key e imposta su Render
`RESEND_API_KEY`, `NOTIFICA_EMAIL` (dove ricevere l'avviso) e, se hai un dominio verificato, `NOTIFICA_DA` (es. `GareCRI <avvisi@fbcri.eu>`).
Senza dominio verificato Resend permette di scrivere solo all'indirizzo con cui ti sei registrato: va bene per avvisare te stesso.

## 7. Ruoli, aree e admin

**Gestione → Ruoli e permessi** (solo admin): crei ruoli (es. Segreteria, Gestore news) e spunti le aree di Gestione che possono usare.
Giudice, giudice master e partecipante sono ruoli di base senza accesso alla Gestione. "Admin" è una spunta in più sull'utente: dà accesso a tutto, compresi Utenti, Ruoli e Richieste.
Ogni utente ha anche una scheda in **Anagrafiche** (creata alla registrazione, all'approvazione di una richiesta o alla creazione manuale). Il codice fiscale è cifrato e lo legge solo l'admin.
Al primo avvio dopo l'aggiornamento gli utenti con vecchio ruolo "admin" diventano "organizzazione + admin".

## Segreteria e badge
**Gestione → Segreteria**: scegli la gara, importa le squadre (o aggiungi le persone una a una), segna "Arrivato" e stampa il badge (anteprima + stampa). Formati pronti: 10 × 7,5 cm e 6 × 9 cm; altri formati si aggiungono da "Formati badge". Il ruolo "Segreteria" (solo quest'area) si assegna da Ruoli e permessi. Nessuna variabile d'ambiente nuova; la migrazione 009 parte da sola al riavvio.

## Esami, corsi e allenamenti
In **Gestione → Gara** il tipo può essere gara, olimpiadi, allenamento, corso o esame. Per esame/corso/allenamento i giudici vedono i punti accanto a ogni livello e la percentuale in tempo reale; per l'esame la soglia di superamento è 75% (modificabile) sul totale della scheda. Dalla scheda, «PDF esito» produce il foglio con voci, punteggio, percentuale, esito e firme. La scala a tre livelli (0/1/2) si ottiene con una scala di punteggio che usa solo tre livelli. La migrazione 011 parte da sola al riavvio.

## Schede private dei comitati
I ruoli **Istruttore**, **Manovre salvavita** e **Monitore** (area «Schede del proprio comitato») creano e modificano solo schede private del proprio comitato, che si ricava dall'anagrafica (la persona collegata all'utente deve avere il comitato). Le schede generali le possono solo leggere e copiare. La direzione (area Schede) le vede solo con la spunta «Vedi anche schede dei comitati» e non le modifica; chi crea i ruoli e li assegna è l'admin (Ruoli e permessi). La migrazione 012 parte da sola al riavvio.

## Menu raggruppato, area Valutazione, Documentazione
Gestione ha cinque contenitori (Gara, Segreteria, Schede, Risultati, Amministrazione) con le sottosezioni come linguette; chi ha un solo permesso (es. Notizie) vede direttamente quella sezione. La Valutazione non compare più in Gestione: è un'area assegnabile ai ruoli (di default giudice, giudice master, direzione). L'area dei comitati si chiama «Formazione d'esame». In **Documentazione** (area omonima) si inseriscono collegamenti https a regolamento, comunicazioni, manuali e formazione: li vedono tutti gli utenti registrati dalla Home. La migrazione 013 parte da sola al riavvio.

## Aspetto (tre layout selezionabili)

Pulsante **Aspetto** in alto a destra: A «Rosso pieno», B «Colonna rossa», C «Bianco con croci».
La scelta è salvata sul profilo (migrazione 014, `utente.tema`) e segue l'utente su ogni dispositivo.
Default: A. API: `PATCH /api/me/tema` con `{ "tema": "a|b|c" }`.
