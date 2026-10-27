#!/usr/bin/env node
// Ripristino di un backup GPSER (file .gpsb scaricato da GitHub o dal pulsante «Scarica il database»).
// Uso:  BACKUP_PASSPHRASE=... node tools/ripristina-backup.mjs FILE            → decifra e riassume il contenuto (non tocca nulla)
//       BACKUP_PASSPHRASE=... DATABASE_URL=... node tools/ripristina-backup.mjs FILE --applica   → svuota e riempie il database indicato
// Il database di destinazione deve avere già lo schema (si crea al primo avvio del sito). Con --applica TUTTI i dati attuali vengono sostituiti.
import fs from 'node:fs';
import zlib from 'node:zlib';
import pg from 'pg';
import { decifra } from '../api/src/backup.js';

const [, , file, flag] = process.argv;
if (!file) { console.error('indica il file del backup'); process.exit(1); }
let buf = fs.readFileSync(file);
if (buf.subarray(0, 5).toString() === 'GPSB1') { if (!process.env.BACKUP_PASSPHRASE) { console.error('serve BACKUP_PASSPHRASE'); process.exit(1); } buf = decifra(buf, process.env.BACKUP_PASSPHRASE); }
const dump = JSON.parse(zlib.gunzipSync(buf).toString());
if (dump.formato !== 'gpser-backup-1') { console.error('formato sconosciuto'); process.exit(1); }
const nomi = Object.keys(dump.tabelle);
console.log(`Backup del ${dump.creato_il}: ${nomi.length} tabelle`);
for (const n of nomi) console.log(`  ${n}: ${dump.tabelle[n].length} righe`);
if (flag !== '--applica') { console.log('\nNulla è stato modificato. Aggiungi --applica per ripristinare.'); process.exit(0); }
if (!process.env.DATABASE_URL) { console.error('serve DATABASE_URL'); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
try {
  await c.query('begin');
  await c.query(`set local session_replication_role = replica`);          // i vincoli tra tabelle si controllano alla fine (richiede un ruolo con questo permesso)
  const esistenti = new Set((await c.query(`select tablename from pg_tables where schemaname='public'`)).rows.map((r) => r.tablename));
  const da = nomi.filter((n) => esistenti.has(n));
  if (da.length) await c.query(`truncate ${da.map((n) => `"${n}"`).join(', ')} restart identity cascade`);
  for (const n of da) if (dump.tabelle[n].length) await c.query(`insert into "${n}" select * from json_populate_recordset(null::"${n}", $1::json)`, [JSON.stringify(dump.tabelle[n])]);
  await c.query('commit'); console.log('\nRipristino completato.');
} catch (e) { await c.query('rollback'); console.error('Ripristino annullato, nulla è cambiato:', e.message); process.exit(1); }
finally { await c.end(); }
