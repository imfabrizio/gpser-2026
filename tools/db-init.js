// Uso: node tools/db-init.js [--reset]
//  - database vuoto: crea lo schema completo
//  - database esistente: applica solo le migrazioni mancanti (db/migrazioni/*.sql, in ordine)
//  - --reset: CANCELLA TUTTO e ricrea (solo per sviluppo)
import fs from 'node:fs';
import { creaPool, inTransazione } from '../api/src/db.js';

const pool = creaPool();
if (process.argv.includes('--reset')) await pool.query('drop schema public cascade; create schema public;');
const { rows: [{ esiste }] } = await pool.query("select to_regclass('public.utente') is not null as esiste");
if (!esiste) {
  await pool.query(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  console.log('schema creato');
} else {
  const dir = new URL('../db/migrazioni/', import.meta.url);
  await pool.query('create table if not exists schema_migrazioni (nome text primary key, applicata_at timestamptz not null default now())');
  const fatte = new Set((await pool.query('select nome from schema_migrazioni')).rows.map((r) => r.nome));
  let n = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (fatte.has(f)) continue;
    await inTransazione(pool, async (db) => {
      await db.query(fs.readFileSync(new URL(f, dir), 'utf8'));
      await db.query('insert into schema_migrazioni (nome) values ($1)', [f]);
    });
    console.log('migrazione applicata:', f); n++;
  }
  if (!n) console.log('schema già aggiornato');
}
await pool.end();
