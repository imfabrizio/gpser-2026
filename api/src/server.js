import { buildApp } from './app.js';
import { creaPool } from './db.js';
import { verificaConfigurazione } from './auth.js';
import { preparaDatabase } from './migrazioni.js';
import { cifraCodiciInChiaro } from './anagrafica.js';

verificaConfigurazione();   // rifiuta l'avvio senza un JWT_SECRET robusto
const pool = creaPool();
if (process.env.AUTO_MIGRAZIONI !== '0') { await preparaDatabase(pool); const n = await cifraCodiciInChiaro(pool); if (n) console.log(`codici fiscali cifrati: ${n}`); }   // schema/migrazioni all'avvio (AUTO_MIGRAZIONI=0 per disattivare)
const app = buildApp(pool, { logger: true });
await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
