# GareCRI – nuova piattaforma di valutazione gare

Sostituisce l'app Power Apps + SharePoint + template Excel. Nessuna dipendenza Microsoft.

**Stack:** PostgreSQL 16 · Node 22 + Fastify · web app responsive (HTML/JS, installabile come PWA) · PDF generati dal server (PDFKit).

## Avvio rapido
```bash
npm install
export DATABASE_URL=postgres://utente@localhost:5432/garecri
npm run db:init                                     # schema nuovo, oppure migrazioni su un DB esistente (--reset cancella tutto)
node tools/import-excel.js api/test/fixtures/scena-alfa.xlsx --codice GPSER-2026 --luogo Piacenza --data 2026-04-18
node tools/crea-utente.js org@esempio.it "Nome Cognome" organizzazione una-password   # ruoli: admin | organizzazione | giudice
npm run dev                                         # http://localhost:3000
npm test                                            # richiede un Postgres: TEST_ADMIN_URL=postgres://.../postgres
```
`JWT_SECRET` (almeno 32 caratteri casuali) è **obbligatorio**: il server non parte senza. Esempio: `export JWT_SECRET=$(openssl rand -base64 48)`. Dietro a un hosting con proxy HTTPS imposta anche `TRUST_PROXY=1` (limite tentativi di login per IP reale).

## Cartelle
| Cartella | Contenuto |
|---|---|
| `db/schema.sql` | modello dati completo, viste classifica/monitor |
| `api/src/app.js` | tutte le rotte REST e i permessi per ruolo |
| `api/src/services/` | `scene.js` (composizione scena da libreria), `compilazioni.js` (sync idempotente), `stampa.js`, `import-excel.js` |
| `api/src/pdf/scheda.js` | disegno della scheda A4 |
| `web/index.html` | login, selezione, inserimento rapido, classifica, monitor |
| `web/coda.js` | coda di salvataggio locale del client (testata) |
| `web/admin.html` | gestione: eventi, squadre, scene, libreria, utenti (ruolo organizzazione/admin) |
| `api/src/routes-gestione.js` | rotte della gestione |
| `db/migrazioni/` | migrazioni per database già esistenti |
| `tools/` | init/migrazione DB, importer Excel, utenti, demo PDF |
| `docs/` | architettura, roadmap, esempi PDF/schermate |

Messa online gratuita (Neon + Render, `render.yaml`, `tools/backup.sh`): `docs/DEPLOY.md`.
Documentazione: `docs/ARCHITETTURA.md`, `docs/ROADMAP.md`, `docs/DEPLOY.md`.
