import { buildApp } from './app.js';
import { creaPool } from './db.js';
import { verificaConfigurazione } from './auth.js';

verificaConfigurazione();   // rifiuta l'avvio senza un JWT_SECRET robusto
const app = buildApp(creaPool(), { logger: true });
await app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
