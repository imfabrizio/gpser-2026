import { buildApp } from './app.js';
import { creaPool } from './db.js';
import { verificaConfigurazione } from './auth.js';
import { preparaDatabase } from './migrazioni.js';

verificaConfigurazione();   // rifiuta l'avvio senza un JWT_SECRET robusto
const pool = creaPool();
if (process.env.AUTO_MIGRAZIONI !== '0') await preparaDatabase(pool);   // schema/migrazioni all'avvio (AUTO_MIGRAZIONI=0 per disattivare)
const app = buildApp(pool, { logger: true });
await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
