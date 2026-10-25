import { buildApp } from './app.js';
import { creaPool } from './db.js';
import { verificaConfigurazione } from './auth.js';
import { preparaDatabase } from './migrazioni.js';
import { cifraCodiciInChiaro } from './anagrafica.js';

verificaConfigurazione();   // rifiuta l'avvio senza un JWT_SECRET robusto
const pool = creaPool();
if (process.env.AUTO_MIGRAZIONI !== '0') { await preparaDatabase(pool); const n = await cifraCodiciInChiaro(pool); if (n) console.log(`codici fiscali cifrati: ${n}`); }   // schema/migrazioni all'avvio (AUTO_MIGRAZIONI=0 per disattivare)
const app = buildApp(pool, { logger: true });
// ADMIN_EMAILS (variabile di Render, indirizzi separati da virgola): all'avvio rende amministratori gli utenti GIÀ registrati con quell'email; non crea account
if (process.env.ADMIN_EMAILS) {
  const mail = process.env.ADMIN_EMAILS.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const r = await pool.query('update utente set admin = true where lower(email) = any($1::text[]) and attivo and not admin', [mail]);
  console.log(`ADMIN_EMAILS: ${r.rowCount} utenti resi amministratori`);
}
await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
