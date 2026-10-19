// Creazione dello schema su un database vuoto e applicazione delle migrazioni mancanti.
// Usato sia da tools/db-init.js sia all'avvio del server (utile su hosting senza terminale).
// Il blocco è per-transazione (pg_advisory_xact_lock): funziona anche dietro un connection pooler
// (es. l'indirizzo "pooled" di Neon), dove i blocchi di sessione non sono affidabili.
import fs from 'node:fs';
import { inTransazione } from './db.js';

const SCHEMA = new URL('../../db/schema.sql', import.meta.url);
const DIR = new URL('../../db/migrazioni/', import.meta.url);
const CHIAVE_BLOCCO = 727401;

export async function preparaDatabase(pool, log = console.log) {
  const creato = await inTransazione(pool, async (db) => {
    await db.query('select pg_advisory_xact_lock($1)', [CHIAVE_BLOCCO]);   // due avvii ravvicinati si mettono in fila
    const { rows: [{ esiste }] } = await db.query("select to_regclass('public.utente') is not null as esiste");
    if (esiste) return false;
    await db.query(fs.readFileSync(SCHEMA, 'utf8'));
    return true;
  });
  if (creato) { log('schema creato'); return; }
  await pool.query('create table if not exists schema_migrazioni (nome text primary key, applicata_at timestamptz not null default now())');
  let n = 0;
  for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) {
    const applicata = await inTransazione(pool, async (db) => {
      await db.query('select pg_advisory_xact_lock($1)', [CHIAVE_BLOCCO]);
      if ((await db.query('select 1 from schema_migrazioni where nome=$1', [f])).rowCount) return false;   // già fatta (da un altro avvio)
      await db.query(fs.readFileSync(new URL(f, DIR), 'utf8'));
      await db.query('insert into schema_migrazioni (nome) values ($1)', [f]);
      return true;
    });
    if (applicata) { log('migrazione applicata: ' + f); n++; }
  }
  if (!n) log('schema già aggiornato');
}
