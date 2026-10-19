// Uso: node tools/import-excel.js <file.xlsx> --codice GPSER-2026 --nome "Gara Regionale" --luogo Piacenza --data 2026-04-18
import { creaPool, inTransazione } from '../api/src/db.js';
import { importaExcel } from '../api/src/services/import-excel.js';

const a = process.argv.slice(2);
const opt = (n, d) => (a.includes(`--${n}`) ? a[a.indexOf(`--${n}`) + 1] : d);
const pool = creaPool();
const rep = await inTransazione(pool, (db) => importaExcel(db, a[0], {
  eventoCodice: opt('codice', 'GPSER-2026'), nomeEvento: opt('nome', 'Gara Regionale di primo soccorso'),
  titoloStampa: opt('titolo', 'Gara Regionale di primo soccorso'),
  luogo: opt('luogo', 'Piacenza'), data: opt('data', '2026-04-18'),
}));
console.log(rep);
await pool.end();
