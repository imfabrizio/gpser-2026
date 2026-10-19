// Uso: node tools/db-init.js [--reset]
//  - database vuoto: crea lo schema completo
//  - database esistente: applica solo le migrazioni mancanti (db/migrazioni/*.sql, in ordine)
//  - --reset: CANCELLA TUTTO e ricrea (solo per sviluppo)
import { creaPool } from '../api/src/db.js';
import { preparaDatabase } from '../api/src/migrazioni.js';

const pool = creaPool();
if (process.argv.includes('--reset')) await pool.query('drop schema public cascade; create schema public;');
await preparaDatabase(pool);
await pool.end();
