import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const ADMIN_URL = process.env.TEST_ADMIN_URL || 'postgres://postgres@localhost:5433/postgres';
const URL_MIG = ADMIN_URL.replace(/\/[^/]*$/, '/garecri_migrazione');

test('migrazione 001 su un database con lo schema "vecchio": applica tutto, è idempotente, tool db-init la rileva', async () => {
  const adm = new pg.Client({ connectionString: ADMIN_URL }); await adm.connect();
  await adm.query('drop database if exists garecri_migrazione'); await adm.query('create database garecri_migrazione'); await adm.end();
  const db = new pg.Client({ connectionString: URL_MIG }); await db.connect();
  await db.query(fs.readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  // riporta il database allo stato precedente alla revisione
  await db.query(`
    drop index evento_unico_attivo;
    alter table scena_scheda_voce drop constraint scena_scheda_voce_check;
    alter table compilazione drop constraint compilazione_scheda_id_fkey, drop constraint compilazione_squadra_id_fkey;
    alter table compilazione add foreign key (scheda_id) references scena_scheda(id) on delete cascade, add foreign key (squadra_id) references squadra(id) on delete cascade;
    alter table risposta drop constraint risposta_voce_id_fkey;
    alter table risposta add foreign key (voce_id) references scena_scheda_voce(id) on delete cascade;
    alter table risposta drop column da_org;
    alter table risposta alter column livello set not null;
    drop table schema_migrazioni;
    drop view v_classifica;
    insert into evento (codice, nome, attivo) values ('A','A',true), ('B','B',true);   -- due eventi attivi: caso reale del vecchio sistema
  `);
  const stato = async () => (await db.query(`
    select (select count(*) from pg_indexes where indexname='evento_unico_attivo')::int as indice,
           (select count(*) from pg_constraint where conrelid='scena_scheda_voce'::regclass and contype='c')::int as chk,
           (select string_agg(confdeltype::text, '') from pg_constraint where conname in ('compilazione_scheda_id_fkey','compilazione_squadra_id_fkey','risposta_voce_id_fkey')) as fk,
           (select count(*) from information_schema.columns where table_name='risposta' and column_name='da_org')::int as da_org,
           (select is_nullable from information_schema.columns where table_name='risposta' and column_name='livello') as nullable,
           (select count(*) from evento where attivo)::int as attivi`)).rows[0];
  const prima = await stato();
  assert.deepEqual([prima.indice, prima.chk, prima.da_org, prima.nullable, prima.attivi], [0, 0, 0, 'NO', 2]);
  const env = { ...process.env, DATABASE_URL: URL_MIG };
  const out1 = execFileSync('node', [new URL('../../tools/db-init.js', import.meta.url).pathname], { env }).toString();
  assert.match(out1, /migrazione applicata: 001-revisione\.sql/);
  const dopo = await stato();
  assert.deepEqual([dopo.indice, dopo.chk, dopo.da_org, dopo.nullable, dopo.attivi], [1, 1, 1, 'YES', 1]);
  assert.match(dopo.fk, /^r+$/);                                                             // tutte restrict
  const out2 = execFileSync('node', [new URL('../../tools/db-init.js', import.meta.url).pathname], { env }).toString();
  assert.match(out2, /già aggiornato/);                                                      // idempotente
  await db.query('drop view v_classifica');   // 004 l'ha ampliata: 001 la ricrea nella forma originale
  await db.query(fs.readFileSync(new URL('../../db/migrazioni/001-revisione.sql', import.meta.url), 'utf8'));   // rilancio diretto
  await db.end();
});

test('preparaDatabase: su un database vuoto crea lo schema, poi non fa nulla; su uno già migrato non ripete', async () => {
  const { preparaDatabase } = await import('../src/migrazioni.js');
  const { creaPool } = await import('../src/db.js');
  const adm = new pg.Client({ connectionString: ADMIN_URL }); await adm.connect();
  await adm.query('drop database if exists garecri_vuoto'); await adm.query('create database garecri_vuoto'); await adm.end();
  const pool = creaPool(ADMIN_URL.replace(/\/[^/]*$/, '/garecri_vuoto'));
  const log = []; const l = (m) => log.push(m);
  await preparaDatabase(pool, l); await preparaDatabase(pool, l);
  assert.deepEqual(log, ['schema creato', 'schema già aggiornato']);
  assert.equal((await pool.query('select count(*)::int n from schema_migrazioni')).rows[0].n, 23);
  assert.equal((await pool.query(`select count(*)::int n from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='ruolo_utente' and enumlabel='giudice_master'`)).rows[0].n, 1);
  await Promise.all([preparaDatabase(pool, l), preparaDatabase(pool, l)]);   // due avvii contemporanei non si pestano i piedi
  await pool.end();
});
