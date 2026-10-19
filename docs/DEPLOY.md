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
