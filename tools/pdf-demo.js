// Uso: node tools/pdf-demo.js <cartella-output>
import fs from 'node:fs';
import { creaPool } from '../api/src/db.js';
import { generaPdfSchede } from '../api/src/services/stampa.js';

const out = process.argv[2] || '.';
const pool = creaPool();
const { rows: [ev] } = await pool.query('select id from evento order by created_at desc limit 1');
const a = await generaPdfSchede(pool, { eventoId: ev.id, scenaCodice: 'A', squadraNumeri: [1], vuote: false });
fs.writeFileSync(`${out}/carpineti_compilata.pdf`, a.pdf);
const b = await generaPdfSchede(pool, { eventoId: ev.id, vuote: true });
fs.writeFileSync(`${out}/schede_vuote.pdf`, b.pdf);
console.log('pagine compilata:', a.pagine, ' vuote:', b.pagine);
await pool.end();
