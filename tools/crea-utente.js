// Uso: node tools/crea-utente.js email "Nome Cognome" ruolo password
import { creaPool } from '../api/src/db.js';
import { hashPassword } from '../api/src/auth.js';
const [email, nome, ruolo, pw] = process.argv.slice(2);
const pool = creaPool();
await pool.query(
  `insert into utente (email, nome, ruolo, password_hash) values ($1,$2,$3,$4)
   on conflict (email) do update set nome=excluded.nome, ruolo=excluded.ruolo, password_hash=excluded.password_hash`,
  [email, nome, ruolo, hashPassword(pw)]);
console.log('utente pronto:', email, ruolo);
await pool.end();
