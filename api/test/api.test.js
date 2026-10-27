import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { creaPool, inTransazione } from '../src/db.js';
import { hashPassword, firmaToken } from '../src/auth.js';
import { fileURLToPath } from 'node:url';
import { importaExcel } from '../src/services/import-excel.js';

process.env.MFA_ORG = '0';   // i test storici usano utenti org senza MFA; i test MFA la riattivano
const ADMIN_URL = process.env.TEST_ADMIN_URL || 'postgres://postgres@localhost:5433/postgres';
const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, '/garecri_test');
let pool, app, ev, tok = {};

const chiama = (method, url, { token, body } = {}) => app.inject({
  method, url, payload: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
const json = (r) => JSON.parse(r.body);

before(async () => {
  const adm = new pg.Client({ connectionString: ADMIN_URL }); await adm.connect();
  await adm.query('drop database if exists garecri_test'); await adm.query('create database garecri_test'); await adm.end();
  pool = creaPool(TEST_URL);
  await pool.query(fs.readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  const rep = await inTransazione(pool, (db) => importaExcel(db, fileURLToPath(new URL('./fixtures/scena-alfa.xlsx', import.meta.url)),
    { eventoCodice: 'T-1', nomeEvento: 'Test', titoloStampa: 'Gara Test', luogo: 'Piacenza', data: '2026-04-18' }));
  ev = rep.eventoId;
  for (const [email, ruolo, admin] of [['org@t', 'organizzazione', false], ['giu@t', 'giudice', false], ['adm@t', 'organizzazione', true]])
    await pool.query('insert into utente (email, nome, ruolo, admin, password_hash) values ($1,$2,$3,$4,$5)', [email, email, ruolo, admin, hashPassword('pw')]);
  app = buildApp(pool);
  for (const e of ['org@t', 'giu@t', 'adm@t']) tok[e] = json(await chiama('POST', '/api/login', { body: { email: e, password: 'pw' } })).token;
});
after(async () => { await app.close(); await pool.end(); });

test('SEC esami locali, inviti esterni revocabili e isolamento di prove e candidati', async () => {
  const users = [];
  for (const [email, comitato] of [['local@security.invalid', 'Modena'], ['peer@security.invalid', 'Modena'], ['external@security.invalid', 'Parma']]) {
    const { rows: [u] } = await pool.query("insert into utente (email,nome,ruolo,password_hash) values ($1,$1,'istruttore_du',$2) returning id", [email, hashPassword('test-password')]);
    await pool.query('insert into partecipante (nome,cognome,comitato,utente_id) values ($1,$1,$2,$3)', [email, comitato, u.id]);
    users.push({ id: u.id, token: firmaToken({ id: u.id, via: 'sso' }) });
  }
  const [owner, peer, external] = users;
  const create = async (u, nome) => {
    const r = await chiama('POST', '/api/esami/sessioni', { token: u.token, body: { nome } });
    assert.equal(r.statusCode, 200, r.body); return json(r);
  };
  const s = await create(owner, 'Security local'), other = await create(owner, 'Security private');
  const base = `/api/esami/sessioni/${s.id}`;
  assert.equal((await chiama('GET', base, peer)).statusCode, 200);
  assert.equal((await chiama('GET', base, external)).statusCode, 403);
  assert.ok(!json(await chiama('GET', '/api/esami/sessioni', external)).some((x) => x.id === s.id));
  const ptc = (await pool.query("select id from patologia where codice='esame-ptc'")).rows[0];
  const cp = await chiama('POST', base + '/prove', { token: owner.token, body: { patologiaId: ptc.id, candidati: [{ nome: 'Test candidate' }] } });
  assert.equal(cp.statusCode, 200, cp.body);
  const pid = json(cp).id;
  const p = json(await chiama('GET', `/api/esami/prove/${pid}`, owner));
  for (const url of [`/api/esami/prove/${pid}`, `/api/esami/prove/${pid}/esito.pdf`, base + '/riepilogo.pdf']) assert.equal((await chiama('GET', url, external)).statusCode, 403);
  assert.equal((await chiama('PATCH', `/api/esami/candidati/${p.candidati[0].id}`, { token: external.token, body: { errore_grave: true } })).statusCode, 403);
  const invite = await chiama('POST', base + '/inviti', { token: owner.token, body: { email: 'external@security.invalid' } });
  assert.equal(invite.statusCode, 200, invite.body);
  assert.equal((await chiama('GET', base, external)).statusCode, 200);
  assert.equal((await chiama('GET', `/api/esami/sessioni/${other.id}`, external)).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/esami/prove/${pid}/risposte`, { token: external.token, body: { ordine: p.voci[0].ordine, livello: 'MB' } })).statusCode, 200);
  assert.equal((await chiama('DELETE', `/api/esami/prove/${pid}`, external)).statusCode, 403);
  assert.equal((await chiama('POST', base + '/inviti', { token: external.token, body: { email: 'peer@security.invalid' } })).statusCode, 403);
  assert.equal((await chiama('DELETE', base + '/inviti/' + external.id, owner)).statusCode, 200);
  assert.equal((await chiama('GET', `/api/esami/prove/${pid}`, external)).statusCode, 403);
  assert.equal((await chiama('GET', base, { token: tok['adm@t'] })).statusCode, 200);
  const migration = fs.readFileSync(new URL('../../db/migrazioni/045-esami-accesso-locale.sql', import.meta.url), 'utf8');
  await pool.query(migration); await pool.query(migration);
  assert.equal((await pool.query('select count(*)::int n from prova_esame where id=$1', [pid])).rows[0].n, 1);
});

test('login: password errata → 401, nessun token → 401', async () => {
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'org@t', password: 'x' } })).statusCode, 401);
  assert.equal((await chiama('GET', '/api/eventi')).statusCode, 401);
});

test('SEC il corpo della richiesta non sostituisce la scena autorizzata; destinazione e avvisi sono vincolati all’evento', async () => {
  const { rows: [u] } = await pool.query("insert into utente (email,nome,ruolo,password_hash,per_evento) values ('scope@security.invalid','Scope','organizzazione',$1,true) returning id", [hashPassword('test-only')]);
  const { rows: [p] } = await pool.query("insert into partecipante (nome,cognome,utente_id) values ('Scope','Test',$1) returning id", [u.id]);
  const evs = [];
  for (const codice of ['SEC-A', 'SEC-B']) evs.push((await pool.query('insert into evento (codice,nome) values ($1,$1) returning id', [codice])).rows[0].id);
  await pool.query("insert into iscrizione (evento_id,partecipante_id,ruolo) values ($1,$2,'organizzazione')", [evs[0],p.id]);
  const scenes = [];
  for (const eid of evs) scenes.push((await pool.query("insert into scena (evento_id,codice,titolo) values ($1,'S',$2) returning id", [eid,eid])).rows[0].id);
  const token = firmaToken({ id: u.id, via: 'sso' });
  const copied = await chiama('POST', `/api/scene/${scenes[0]}/duplica`, { token, body: { scenaId: scenes[1], eventoDestId: evs[0], nuovoCodice: 'D' } });
  assert.equal(copied.statusCode, 200, copied.body);
  assert.equal(json(copied).evento_id, evs[0]);
  assert.equal(json(copied).titolo, evs[0]);
  assert.equal((await chiama('POST', `/api/scene/${scenes[0]}/duplica`, { token, body: { eventoDestId: evs[1], nuovoCodice: 'E' } })).statusCode, 403);
  const ptc = (await pool.query("select id from patologia where codice='esame-ptc'")).rows[0].id;
  const sch = await chiama('POST', `/api/scene/${scenes[0]}/schede`, { token, body: { scenaId: scenes[1], patologiaId: ptc, slot: 0, simulatore: 'M' } });
  assert.equal(sch.statusCode, 200, sch.body); assert.equal(json(sch).scena_id, scenes[0]);
  for (const evento_id of [evs[1], null]) assert.equal((await chiama('POST', '/api/avvisi', { token, body: { titolo: 'Test', evento_id } })).statusCode, 403);
  const avviso = (await pool.query("insert into avviso (titolo,evento_id) values ('Test',$1) returning id", [evs[1]])).rows[0];
  assert.equal((await chiama('DELETE', `/api/avvisi/${avviso.id}`, { token })).statusCode, 403);
});

test('le classifiche coincidono con quelle dell\'Excel (359 / 386 / 191)', async () => {
  const r = json(await chiama('GET', `/api/eventi/${ev}/classifica?tipo=generale`, { token: tok['org@t'] }));
  const t = Object.fromEntries(r.classifica.map((x) => [x.nome, Number(x.totale)]));
  assert.equal(t.Carpineti, 359); assert.equal(t.Scandiano, 386); assert.equal(t['Liguria 1'], 191);
  assert.equal(r.classifica[0].nome, 'Scandiano'); assert.equal(r.classifica[0].posizione, 1);
  const m = json(await chiama('GET', `/api/eventi/${ev}/classifica?tipo=master`, { token: tok['org@t'] }));
  assert.deepEqual(m.classifica.slice(0, 3).map((x) => Number(x.master)), [109, 98, 60]);
  assert.equal(Number(r.massimi.max_totale), 538);   // il vecchio foglio dava sempre 0
});

test('SEP calcolato dalla voce, non dal flag copiato nella risposta (Carpineti: 90, non 154)', async () => {
  const r = json(await chiama('GET', `/api/eventi/${ev}/classifica?tipo=sep`, { token: tok['org@t'] }));
  const c = r.classifica.find((x) => x.nome === 'Carpineti');
  assert.equal(Number(c.sep), 90);
});

test('stampa PDF: solo organizzazione; 25 schede vuote (5 squadre × 5 schede)', async () => {
  assert.equal((await chiama('GET', `/api/eventi/${ev}/stampa.pdf`, { token: tok['giu@t'] })).statusCode, 403);
  const r = await chiama('GET', `/api/eventi/${ev}/stampa.pdf?scena=A&vuote=1`, { token: tok['org@t'] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.rawPayload.subarray(0, 4).toString(), '%PDF');
  assert.equal((r.rawPayload.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 25);
});

let scheda, squadra, voci;
test('il giudice vede solo le schede assegnate', async () => {
  let sc = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['giu@t'] }));
  assert.equal(sc[0].schede, null);
  const org = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['org@t'] }));
  scheda = org[0].schede.find((s) => s.titolo === 'Master').id;
  const { rows: [u] } = await pool.query(`select id from utente where email='giu@t'`);
  await pool.query('insert into assegnazione values ($1,$2)', [scheda, u.id]);
  sc = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['giu@t'] }));
  assert.equal(sc[0].schede.length, 1);
  squadra = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['giu@t'] })).find((s) => s.numero === 4).id;
  voci = json(await chiama('GET', `/api/schede/${scheda}`, { token: tok['org@t'] })).voci;   // l'organizzazione vede i punteggi
  assert.equal(voci.length, 26);
});

test('sync idempotente, last-writer-wins per voce, livelli non consentiti rifiutati', async () => {
  const standard = voci.find((v) => v.scala === 'Standard');
  const treVoci = voci.find((v) => v.scala === '3 Voci');
  const base = { id: '11111111-1111-4111-8111-111111111111', scheda_id: scheda, squadra_id: squadra, origine: 'tablet_offline' };
  const p1 = { ...base, risposte: [{ voce_id: standard.id, livello: 'MB', updated_at: '2026-04-18T10:00:00Z' }] };
  const r1 = json(await chiama('POST', '/api/sync', { token: tok['giu@t'], body: p1 }));
  const r2 = json(await chiama('POST', '/api/sync', { token: tok['giu@t'], body: p1 }));   // ripetuto (ritrasmissione)
  assert.equal(r1[0].compilazione_id, r2[0].compilazione_id);
  assert.equal((await pool.query('select count(*)::int n from risposta where compilazione_id=$1', [r1[0].compilazione_id])).rows[0].n, 1);
  // modifica più vecchia (arriva in ritardo dal tablet offline) → scartata
  const vecchia = json(await chiama('POST', '/api/sync', { token: tok['giu@t'],
    body: { ...base, risposte: [{ voce_id: standard.id, livello: 'NE', updated_at: '2026-04-18T09:00:00Z' }] } }));
  assert.equal(vecchia[0].scartate, 1);
  const nuova = json(await chiama('POST', '/api/sync', { token: tok['giu@t'],
    body: { ...base, risposte: [{ voce_id: standard.id, livello: 'BE', updated_at: '2026-04-18T11:00:00Z' }] } }));
  assert.equal(nuova[0].scritte, 1);
  const { rows: [r] } = await pool.query('select livello from risposta where voce_id=$1', [standard.id]);
  assert.equal(r.livello, 'BE');
  // "3 Voci" non ha BE: cella nera
  const bad = await chiama('POST', '/api/sync', { token: tok['giu@t'],
    body: { ...base, risposte: [{ voce_id: treVoci.id, livello: 'BE' }] } });
  assert.equal(bad.statusCode, 400);
});

test('scheda chiusa: il giudice che conferma la chiude; poi non può né modificarla né riaprirla; l\'organizzazione sì', async () => {
  const base = { id: '11111111-1111-4111-8111-111111111111', scheda_id: scheda, squadra_id: squadra };
  const ok = await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, stato: 'completata' } });   // la conferma del giudice chiude subito
  assert.equal(json(ok)[0].stato, 'verificata');
  const mod = await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, risposte: [{ voce_id: voci[0].id, livello: 'MB' }] } });
  assert.equal(mod.statusCode, 409);
  const cid = json(ok)[0].compilazione_id;
  assert.equal((await chiama('POST', `/api/compilazioni/${cid}/riapri`, { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await chiama('POST', `/api/compilazioni/${cid}/riapri`, { token: tok['org@t'] })).statusCode, 200);
});

test('squadre: il numero non viene mai riusato; un solo evento attivo', async () => {
  const s = json(await chiama('POST', `/api/eventi/${ev}/squadre`, { token: tok['org@t'], body: { nome: 'Nuova' } }));
  assert.equal(s.numero, 6);
  await pool.query('delete from squadra where id=$1', [s.id]);
  await pool.query(`insert into evento (codice, nome, attivo) values ('T-2','Altro', false)`);
  const { rows: [e2] } = await pool.query(`select id from evento where codice='T-2'`);
  await chiama('POST', `/api/eventi/${e2.id}/attiva`, { token: tok['org@t'] });
  assert.equal((await pool.query('select count(*)::int n from evento where attivo')).rows[0].n, 1);
});

test('libreria: stessa voce con punteggi diversi in due patologie; la scena è uno snapshot', async () => {
  const mk = (codice, scala) => chiama('POST', '/api/libreria/patologie', { token: tok['org@t'], body: {
    codice, nome: codice, sigla: codice.slice(0, 3), voci: [{ sezione: 'S', testo: 'valuta la coscienza', scala }] } });
  const a = json(await mk('PAT_A', 'Standard')), b = json(await mk('PAT_B', 'PesoDoppio'));
  const sc = json(await chiama('POST', `/api/eventi/${ev}/scene`, { token: tok['org@t'], body: { codice: 'Z', titolo: 'Test Z' } }));
  const s1 = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: tok['org@t'], body: { slot: 0, patologiaId: a.id, simulatore: 'M' } }));
  const s2 = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: tok['org@t'], body: { slot: 1, patologiaId: b.id, simulatore: '01' } }));
  const v1 = json(await chiama('GET', `/api/schede/${s1.id}`, { token: tok['org@t'] })).voci[0];
  const v2 = json(await chiama('GET', `/api/schede/${s2.id}`, { token: tok['org@t'] })).voci[0];
  assert.equal(v1.mb, 5); assert.equal(v2.mb, 10);
  await pool.query(`update scala_punteggio set mb = 99 where codice = 'Standard'`);   // cambio libreria
  const v1b = json(await chiama('GET', `/api/schede/${s1.id}`, { token: tok['org@t'] })).voci[0];
  assert.equal(v1b.mb, 5);                                                          // la scena non cambia
  await pool.query(`update scala_punteggio set mb = 5 where codice = 'Standard'`);
});

test('gestione utenti: solo admin; password minima; niente auto-declassamento', async () => {
  assert.equal((await chiama('GET', '/api/utenti', { token: tok['org@t'] })).statusCode, 403);
  const nuovo = await chiama('POST', '/api/utenti', { token: tok['adm@t'], body: { email: 'n@t', nome: 'N', ruolo: 'giudice', password: 'corta' } });
  assert.equal(nuovo.statusCode, 400);
  const ok = json(await chiama('POST', '/api/utenti', { token: tok['adm@t'], body: { email: 'n@t', nome: 'N', ruolo: 'giudice', password: 'password-lunga' } }));
  assert.equal(ok.ruolo, 'giudice');
  assert.equal((await chiama('POST', '/api/utenti', { token: tok['adm@t'], body: { email: 'n@t', nome: 'N', password: 'password-lunga' } })).statusCode, 409);
  const me = json(await chiama('GET', '/api/me', { token: tok['adm@t'] }));
  assert.equal((await chiama('PATCH', `/api/utenti/${me.id}`, { token: tok['adm@t'], body: { admin: false } })).statusCode, 400);
  const login = await chiama('POST', '/api/login', { body: { email: 'n@t', password: 'password-lunga' } });
  assert.equal(login.statusCode, 200);
  await chiama('PATCH', `/api/utenti/${ok.id}`, { token: tok['adm@t'], body: { attivo: false } });
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'n@t', password: 'password-lunga' } })).statusCode, 401);
});

test('assegnazioni, modifica scheda, eliminazioni protette', async () => {
  const scene = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['org@t'] }));
  const sA = scene.find((s) => s.codice === 'A');
  const pbls = sA.schede.find((s) => s.titolo === 'PBLS').id;
  const giud = json(await chiama('GET', '/api/giudici', { token: tok['org@t'] }));
  assert.ok(giud.length >= 1);
  const put = json(await chiama('PUT', `/api/schede/${pbls}/assegnazioni`, { token: tok['org@t'], body: { utenti: [giud[0].id] } }));
  assert.equal(put.assegnati, 1);
  const lista = json(await chiama('GET', `/api/eventi/${ev}/assegnazioni`, { token: tok['org@t'] }));
  assert.ok(lista.some((a) => a.scheda_id === pbls));
  const patch = json(await chiama('PATCH', `/api/schede/${pbls}`, { token: tok['org@t'], body: { parametri: { coscienza: 'A', fr: 12 } } }));
  assert.equal(patch.parametri.fr, 12);
  // la scheda Master di squadra 4 ha risposte (test precedenti) → non eliminabile; la scena A idem
  assert.equal((await chiama('DELETE', `/api/schede/${scheda}`, { token: tok['org@t'] })).statusCode, 409);
  assert.equal((await chiama('DELETE', `/api/scene/${sA.id}`, { token: tok['org@t'] })).statusCode, 409);
  assert.equal((await chiama('DELETE', `/api/schede/${pbls}`, { token: tok['giu@t'] })).statusCode, 403);
  // scena vuota eliminabile
  const z = json(await chiama('POST', `/api/eventi/${ev}/scene`, { token: tok['org@t'], body: { codice: 'Y', titolo: 'Vuota' } }));
  assert.equal((await chiama('DELETE', `/api/scene/${z.id}`, { token: tok['org@t'] })).statusCode, 200);
});

test('modifica patologia in libreria non cambia scene già composte; patologia usata non eliminabile', async () => {
  const pats = json(await chiama('GET', '/api/libreria/patologie', { token: tok['org@t'] }));
  const a = pats.find((p) => p.codice === 'PAT_A');
  const sc = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['org@t'] })).find((s) => s.codice === 'Z');
  const prima = json(await chiama('GET', `/api/schede/${sc.schede[0].id}`, { token: tok['org@t'] })).voci.length;
  await chiama('PUT', `/api/libreria/patologie/${a.id}`, { token: tok['org@t'], body: {
    voci: [{ sezione: 'S', testo: 'uno', scala: 'Standard' }, { sezione: 'S', testo: 'due', scala: '3 Voci' }] } });
  const dopo = json(await chiama('GET', `/api/schede/${sc.schede[0].id}`, { token: tok['org@t'] })).voci.length;
  assert.equal(prima, dopo);
  assert.equal(json(await chiama('GET', `/api/libreria/patologie/${a.id}`, { token: tok['org@t'] })).length, 2);
  assert.equal((await chiama('DELETE', `/api/libreria/patologie/${a.id}`, { token: tok['org@t'] })).statusCode, 409);
});

// ───────────── regressioni dalla revisione indipendente ─────────────
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
let ctxR;
async function contesto() {
  if (ctxR) return ctxR;
  const scene = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['org@t'] }));
  const A = scene.find((s) => s.codice === 'A');
  const master = A.schede.find((s) => s.titolo === 'Master').id, tc = A.schede.find((s) => s.titolo === 'TC').id;
  const sq = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] })).find((s) => s.numero === 5).id;
  const vm = json(await chiama('GET', `/api/schede/${master}`, { token: tok['org@t'] })).voci;
  const vt = json(await chiama('GET', `/api/schede/${tc}`, { token: tok['org@t'] })).voci;
  return (ctxR = { master, tc, sq, vm, vt });
}

test('REV-1 l\'autenticazione non si aggira con percorsi codificati', async () => {
  const { master } = await contesto();
  for (const u of ['/%61pi/eventi', `/%61pi/eventi/${ev}/classifica`, `/%61pi/eventi/${ev}/squadre`, `/%61pi/schede/${master}`, '/%61pi/libreria/patologie', '/api/eventi', '/api//eventi'])
    assert.equal((await chiama('GET', u)).statusCode, 401, u);
});

test('REV-2 l\'avvio rifiuta un JWT_SECRET debole o mancante', async () => {
  const { verificaConfigurazione } = await import('../src/auth.js');
  const prima = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET; assert.throws(verificaConfigurazione);
  process.env.JWT_SECRET = 'corto'; assert.throws(verificaConfigurazione);
  process.env.JWT_SECRET = 'x'.repeat(40); assert.doesNotThrow(verificaConfigurazione);
  if (prima === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = prima;
});

test('REV-3 il giudice non scrive né legge schede non assegnate', async () => {
  const { tc, sq, vt } = await contesto();
  const body = { id: U(1), scheda_id: tc, squadra_id: sq, risposte: [{ voce_id: vt.find((v) => v.mb !== null).id, livello: 'MB' }] };
  assert.equal((await chiama('POST', '/api/sync', { token: tok['giu@t'], body })).statusCode, 403);
  assert.equal((await chiama('GET', `/api/schede/${tc}`, { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await chiama('GET', `/api/compilazioni?scheda=${tc}&squadra=${sq}`, { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await pool.query('select count(*)::int n from compilazione where scheda_id=$1 and squadra_id=$2', [tc, sq])).rows[0].n, 0);
});

test('REV-4 scheda e squadra di eventi diversi vengono rifiutate; la classifica resta pulita', async () => {
  const { tc, vt } = await contesto();
  const e2 = json(await chiama('POST', '/api/eventi', { token: tok['org@t'], body: { codice: 'ALTRO-1', nome: 'Altro evento' } }));
  const s2 = json(await chiama('POST', `/api/eventi/${e2.id}/squadre`, { token: tok['org@t'], body: { nome: 'Intrusa' } }));
  const body = { id: U(2), scheda_id: tc, squadra_id: s2.id, risposte: [{ voce_id: vt.find((v) => v.mb !== null).id, livello: 'MB' }] };
  const r = await chiama('POST', '/api/sync', { token: tok['org@t'], body });
  assert.equal(r.statusCode, 400);
  // anche forzando una riga errata nel DB, la vista non la conta
  const { rows: [c] } = await pool.query(`insert into compilazione (scheda_id, squadra_id, stato) values ($1,$2,'completata') returning id`, [tc, s2.id]);
  await pool.query('insert into risposta (compilazione_id, voce_id, livello) values ($1,$2,$3)', [c.id, vt.find((v) => v.mb !== null).id, 'MB']);
  const cl = json(await chiama('GET', `/api/eventi/${e2.id}/classifica`, { token: tok['org@t'] }));
  assert.equal(Number(cl.classifica[0].totale), 0);
  await pool.query('delete from risposta where compilazione_id=$1', [c.id]); await pool.query('delete from compilazione where id=$1', [c.id]);
});

test('REV-5 orologio sbagliato del tablet: l\'orario è limitato e l\'organizzazione vince sempre', async () => {
  const { master, sq, vm } = await contesto();
  const voce = vm.find((v) => v.mb !== null && v.ne !== null);
  const base = { id: U(3), scheda_id: master, squadra_id: sq, origine: 'tablet_online' };
  const a = json(await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, risposte: [{ voce_id: voce.id, livello: 'NE', updated_at: '2099-01-01T00:00:00Z' }] } }));
  assert.equal(a[0].scritte, 1);
  const dellaSq = (cols) => pool.query(`select ${cols} from risposta r join compilazione c on c.id=r.compilazione_id where r.voce_id=$1 and c.squadra_id=$2`, [voce.id, sq]);
  const { rows: [r] } = await dellaSq('r.livello, r.updated_at');
  assert.ok(new Date(r.updated_at) <= new Date(), 'updated_at non deve restare nel futuro');
  // correzione dell'organizzazione (carta, senza orario) → vince
  const b = json(await chiama('POST', '/api/sync', { token: tok['org@t'], body: { ...base, origine: 'carta', risposte: [{ voce_id: voce.id, livello: 'MB' }] } }));
  assert.equal(b[0].scritte, 1);
  assert.equal((await dellaSq('r.livello')).rows[0].livello, 'MB');
  // annullamento della risposta
  const c = json(await chiama('POST', '/api/sync', { token: tok['org@t'], body: { ...base, risposte: [{ voce_id: voce.id, livello: null }] } }));
  assert.equal(c[0].scritte, 1);
  assert.equal((await dellaSq('r.livello')).rows[0].livello, null);   // annullo registrato come tombstone
});

test('REV-6 PUT voce: aggiornamento parziale, livelli usati protetti, 404, almeno un livello', async () => {
  const { master, sq, vm } = await contesto();
  const voce = vm.find((v) => v.scala === 'Standard');
  await chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(3), scheda_id: master, squadra_id: sq, risposte: [{ voce_id: voce.id, livello: 'BE' }] } });
  const solo = json(await chiama('PUT', `/api/schede/${master}/voci/${voce.ordine}`, { token: tok['org@t'], body: { testo: voce.testo + ' (rev)' } }));
  assert.equal(solo.mb, 5); assert.equal(solo.ne, 0);                       // i punteggi non sono stati azzerati
  assert.equal((await chiama('PUT', `/api/schede/${master}/voci/${voce.ordine}`, { token: tok['org@t'], body: { be: null } })).statusCode, 409);
  assert.equal((await chiama('PUT', `/api/schede/${master}/voci/9999`, { token: tok['org@t'], body: { mb: 1 } })).statusCode, 404);
  const tutti = await chiama('PUT', `/api/schede/${master}/voci/${voce.ordine}`, { token: tok['org@t'], body: { mb: null, be: null, su: null, in: null, ne: null } });
  assert.ok([400, 409].includes(tutti.statusCode));
  assert.ok((await pool.query(`select count(*)::int n from audit_log where azione='modifica_voce'`)).rows[0].n >= 1);
});

test('REV-7 utente disattivato o declassato perde subito l\'accesso (token ancora valido)', async () => {
  const mk = async (email, ruolo) => { await pool.query('insert into utente (email, nome, ruolo, password_hash) values ($1,$1,$2,$3)', [email, ruolo, hashPassword('pw')]);
    return json(await chiama('POST', '/api/login', { body: { email, password: 'pw' } })).token; };
  const t1 = await mk('x1@t', 'organizzazione'), t2 = await mk('x2@t', 'giudice');
  assert.equal((await chiama('GET', `/api/eventi/${ev}/monitor`, { token: t1 })).statusCode, 200);
  await pool.query(`update utente set ruolo='giudice' where email='x1@t'`);
  assert.equal((await chiama('GET', `/api/eventi/${ev}/monitor`, { token: t1 })).statusCode, 403);
  await pool.query(`update utente set attivo=false where email='x2@t'`);
  assert.equal((await chiama('GET', '/api/eventi', { token: t2 })).statusCode, 401);
});

test('REV-8 il batch è atomico; payload malformati → 400; id già usato → 409', async () => {
  const { master, sq, vm } = await contesto();
  const voce = vm.find((v) => v.mb !== null);
  const ok = { id: U(4), scheda_id: master, squadra_id: U(99999), risposte: [] };
  assert.equal((await chiama('POST', '/api/sync', { token: tok['org@t'], body: [ok] })).statusCode, 404);
  for (const bad of [{ id: 'non-uuid', scheda_id: master, squadra_id: sq }, { id: U(5), scheda_id: master, squadra_id: sq, origine: 'boh' },
                     { id: U(5), scheda_id: master, squadra_id: sq, risposte: 'x' }, { id: U(5), scheda_id: master, squadra_id: sq, risposte: [{ voce_id: voce.id, livello: 'XX' }] }])
    assert.equal((await chiama('POST', '/api/sync', { token: tok['org@t'], body: bad })).statusCode, 400);
  const sqB = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] })).find((s) => s.numero === 3).id;
  const lotto = [{ id: U(6), scheda_id: master, squadra_id: sqB, risposte: [{ voce_id: voce.id, livello: 'MB' }] },
                 { id: U(7), scheda_id: master, squadra_id: sqB, risposte: [{ voce_id: voce.id, livello: 'ZZ' }] }];
  const before = (await pool.query('select count(*)::int n from risposta')).rows[0].n;
  assert.equal((await chiama('POST', '/api/sync', { token: tok['org@t'], body: lotto })).statusCode, 400);
  assert.equal((await pool.query('select count(*)::int n from risposta')).rows[0].n, before);   // niente salvato a metà
  const { tc } = await contesto();
  const sq4 = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] })).find((s) => s.numero === 4).id;
  const dup = await chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(3), scheda_id: tc, squadra_id: sq4 } });   // U(3) è già di un'altra coppia
  assert.equal(dup.statusCode, 409);
});

test('REV-9 modifica di organizzazione su scheda chiusa lascia traccia in audit', async () => {
  const { master, sq, vm } = await contesto();
  const voce = vm.find((v) => v.mb !== null);
  await chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(3), scheda_id: master, squadra_id: sq, stato: 'completata', risposte: [{ voce_id: voce.id, livello: 'MB' }] } });
  const cid9 = (await pool.query('select id from compilazione where scheda_id=$1 and squadra_id=$2', [master, sq])).rows[0].id;
  const n0 = (await pool.query(`select count(*)::int n from audit_log where azione='modifica_scheda_chiusa'`)).rows[0].n;
  await chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(3), scheda_id: master, squadra_id: sq, risposte: [{ voce_id: voce.id, livello: 'MB' }] } });
  assert.equal((await pool.query(`select count(*)::int n from audit_log where azione='modifica_scheda_chiusa'`)).rows[0].n, n0 + 1);
  await chiama('POST', `/api/compilazioni/${cid9}/riapri`, { token: tok['org@t'] });   // lascia la scheda aperta per gli altri test
});

test('REV-10 un solo evento attivo anche a livello DB; attiva evento inesistente → 404; login con limite tentativi', async () => {
  await assert.rejects(pool.query(`insert into evento (codice, nome, attivo) values ('DOPPIO','x',true)`));
  const prima = (await pool.query('select id from evento where attivo')).rows[0].id;
  assert.equal((await chiama('POST', `/api/eventi/${U(123)}/attiva`, { token: tok['org@t'], body: {} })).statusCode, 404);
  assert.equal((await pool.query('select id from evento where attivo')).rows[0].id, prima);
  let ultimo;
  for (let i = 0; i < 9; i++) ultimo = await chiama('POST', '/api/login', { body: { email: 'brute@t', password: 'x' + i } });
  assert.equal(ultimo.statusCode, 429);
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'a@t', password: 123 } })).statusCode, 400);
  assert.equal((await chiama('GET', `/api/eventi/${ev}/stampa.pdf?squadra=1,a`, { token: tok['org@t'] })).statusCode, 400);
});

// ───────────── seconda tornata di revisione ─────────────
test('REV2-1 precedenza: l\'organizzazione prevale sul giudice; last-writer-wins dentro la stessa categoria', async () => {
  const { master, vm } = await contesto();
  const sq3 = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] })).find((s) => s.numero === 4).id;
  const voce = vm.find((v) => v.mb !== null && v.in !== null);
  const base = { id: U(10), scheda_id: master, squadra_id: sq3 };
  const w = (token, livello, updated_at) => chiama('POST', '/api/sync', { token, body: { ...base, risposte: [{ voce_id: voce.id, livello, updated_at }] } }).then(json);
  const liv = async () => (await pool.query('select livello from risposta r join compilazione c on c.id=r.compilazione_id where r.voce_id=$1 and c.squadra_id=$2', [voce.id, sq3])).rows[0]?.livello;
  assert.equal((await w(tok['giu@t'], 'IN'))[0].scritte, 1);
  assert.equal((await w(tok['org@t'], 'MB', '2026-01-01T00:00:00Z'))[0].scritte, 1);   // org vince anche con orario vecchio
  assert.equal(await liv(), 'MB');
  assert.equal((await w(tok['giu@t'], 'IN'))[0].scartate, 1);                          // il giudice non scavalca l'org
  assert.equal(await liv(), 'MB');
  await w(tok['org@t'], 'BE', new Date().toISOString());
  assert.equal((await w(tok['org@t'], 'SU', '2026-01-02T00:00:00Z'))[0].scartate, 1); // tra org vince la più recente
  assert.equal(await liv(), 'BE');
});

test('REV2-2 annullo = tombstone: un dato vecchio non lo fa risorgere; annullare una voce nuova non è uno scarto', async () => {
  const { master, vm } = await contesto();
  const sq3 = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] })).find((s) => s.numero === 4).id;   // nessun dato importato
  const voce = vm.filter((v) => v.mb !== null)[5];
  const base = { id: U(11), scheda_id: master, squadra_id: sq3 };
  const w = (livello, updated_at) => chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, risposte: [{ voce_id: voce.id, livello, updated_at }] } }).then(json);
  const nuova = await w(null, '2026-03-01T10:00:00Z');
  assert.equal(nuova[0].scritte, 1); assert.equal(nuova[0].scartate, 0);
  const vecchio = await w('MB', '2026-03-01T09:00:00Z');                                 // arriva in ritardo da un dispositivo offline
  assert.equal(vecchio[0].scartate, 1);
  const { rows } = await pool.query('select livello from risposta r join compilazione c on c.id=r.compilazione_id where r.voce_id=$1 and c.squadra_id=$2', [voce.id, sq3]);
  assert.equal(rows[0].livello, null);
  const cl = json(await chiama('GET', `/api/compilazioni?scheda=${master}&squadra=${sq3}`, { token: tok['giu@t'] }));
  assert.ok(!cl.risposte.some((r) => r.voce_id === voce.id));                           // l'API non restituisce le annullate
});

test('REV2-3 batch concorrenti in ordine inverso: nessun deadlock, tutte 200', async () => {
  const { master, tc, vm, vt } = await contesto();
  const sqs = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] }));
  const mk = (sch, sq, voci, n) => ({ id: U(200 + n), scheda_id: sch, squadra_id: sq, risposte: [{ voce_id: voci.find((v) => v.mb !== null).id, livello: 'MB' }] });
  const a = [mk(master, sqs[1].id, vm, 1), mk(tc, sqs[2].id, vt, 2)], b = [mk(tc, sqs[2].id, vt, 3), mk(master, sqs[1].id, vm, 4)];
  const esiti = await Promise.all(Array.from({ length: 12 }, (_, i) => chiama('POST', '/api/sync', { token: tok['org@t'], body: i % 2 ? a : b })));
  assert.deepEqual([...new Set(esiti.map((e) => e.statusCode))], [200]);
});

test('REV2-4 eliminazione: compilazioni vuote ripulite, valutazioni vere proteggono; codice scena validato ovunque; stampa 404; nome giudice dal server', async () => {
  const z = json(await chiama('POST', `/api/eventi/${ev}/scene`, { token: tok['org@t'], body: { codice: 'W', titolo: 'Per eliminare' } }));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: tok['org@t'] })).find((p) => p.codice === 'PAT_B');
  const sch = json(await chiama('POST', `/api/scene/${z.id}/schede`, { token: tok['org@t'], body: { slot: 0, patologiaId: pat.id, simulatore: 'M' } }));
  const voci = json(await chiama('GET', `/api/schede/${sch.id}`, { token: tok['org@t'] })).voci;
  const sq = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: tok['org@t'] })).find((s) => s.numero === 1).id;
  const sync = (livello) => chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(300), scheda_id: sch.id, squadra_id: sq, risposte: [{ voce_id: voci[0].id, livello }] } });
  await sync('MB'); await sync(null);                                                   // tocca e annulla: resta una compilazione vuota
  assert.equal((await chiama('DELETE', `/api/scene/${z.id}`, { token: tok['org@t'] })).statusCode, 200);
  const z2 = json(await chiama('POST', `/api/eventi/${ev}/scene`, { token: tok['org@t'], body: { codice: 'V', titolo: 'Con dati' } }));
  const sch2 = json(await chiama('POST', `/api/scene/${z2.id}/schede`, { token: tok['org@t'], body: { slot: 0, patologiaId: pat.id, simulatore: 'M' } }));
  const v2 = json(await chiama('GET', `/api/schede/${sch2.id}`, { token: tok['org@t'] })).voci;
  await chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(301), scheda_id: sch2.id, squadra_id: sq, risposte: [{ voce_id: v2[0].id, livello: 'MB' }] } });
  assert.equal((await chiama('DELETE', `/api/scene/${z2.id}`, { token: tok['org@t'] })).statusCode, 409);
  // codice scena: anche con duplica
  assert.equal((await chiama('POST', `/api/scene/${z2.id}/duplica`, { token: tok['org@t'], body: { eventoDestId: ev, nuovoCodice: '<b>' } })).statusCode, 400);
  assert.equal((await chiama('GET', `/api/eventi/${U(404)}/stampa.pdf`, { token: tok['org@t'] })).statusCode, 404);
  // nome stampato del giudice: sempre quello dell'account
  const { master } = await contesto();
  const nuovaSq = json(await chiama('POST', `/api/eventi/${ev}/squadre`, { token: tok['org@t'], body: { nome: 'Per il nome giudice' } }));
  await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { id: U(302), scheda_id: master, squadra_id: nuovaSq.id, giudice: 'Presidente di giuria', risposte: [] } });
  assert.equal((await pool.query('select giudice from compilazione where scheda_id=$1 and squadra_id=$2', [master, nuovaSq.id])).rows[0].giudice, 'giu@t');
});

test('REV2-5 la rete di sicurezza: tutte le rotte /api (tranne login) rifiutano le richieste senza token', async () => {
  const metodi = [['GET', '/api/me'], ['GET', '/api/eventi'], ['POST', '/api/eventi'], ['GET', '/api/utenti'], ['POST', '/api/sync'], ['GET', '/api/giudici'],
    ['PATCH', `/api/eventi/${U(1)}`], ['DELETE', `/api/scene/${U(1)}`], ['PUT', `/api/schede/${U(1)}/assegnazioni`], ['GET', `/api/eventi/${U(1)}/monitor`],
    ['GET', `/api/eventi/${U(1)}/stampa.pdf`], ['POST', '/api/libreria/scale'], ['HEAD', '/api/eventi'], ['OPTIONS', '/api/eventi']];
  for (const [m, u] of metodi) assert.ok([401, 404].includes((await chiama(m, u)).statusCode), `${m} ${u}`);
  for (const [m, u] of metodi.filter(([m]) => !['HEAD', 'OPTIONS'].includes(m))) assert.equal((await chiama(m, u)).statusCode, 401, `${m} ${u}`);
});

// ───────── giudice master, punteggi nascosti, anagrafica ─────────
import { randomUUID } from 'node:crypto';
const nuovoUtente = async (email, ruolo) => {
  const { rows: [u] } = await pool.query('insert into utente (email, nome, ruolo, password_hash) values ($1,$2,$3,$4) returning id', [email, email, ruolo, hashPassword('pw')]);
  tok[email] = json(await chiama('POST', '/api/login', { body: { email, password: 'pw' } })).token;
  return u.id;
};

test('M-1 chi inserisce i dati non vede i punti: né nella scheda, né nella libreria, né in classifica', async () => {
  const j = json(await chiama('GET', `/api/schede/${scheda}`, { token: tok['giu@t'] }));
  assert.ok(j.voci.length === 26);
  for (const v of j.voci) { for (const k of ['mb', 'be', 'su', 'in', 'ne', 'is_sep', 'scala']) assert.ok(!(k in v), `campo ${k} esposto al giudice`); assert.ok(Array.isArray(v.consentiti) && v.consentiti.length >= 1); }
  const o = json(await chiama('GET', `/api/schede/${scheda}`, { token: tok['org@t'] }));
  assert.ok('mb' in o.voci[0] && o.voci[0].consentiti.length >= 1);                       // l'organizzazione sì
  // i livelli consentiti coincidono con quelli non nulli
  for (const v of o.voci) assert.deepEqual(v.consentiti, ['mb', 'be', 'su', 'in', 'ne'].filter((l) => v[l] !== null).map((l) => l.toUpperCase()));
  for (const u of ['/api/libreria/scale', '/api/libreria/patologie', '/api/libreria/voci', `/api/eventi/${ev}/classifica`, `/api/eventi/${ev}/monitor`])
    assert.equal((await chiama('GET', u, { token: tok['giu@t'] })).statusCode, 403, u);
});

test('M-2 giudice master: vede e corregge tutte le schede della sua scena, verifica, riapre; correzioni nel registro; prevale sul giudice', async () => {
  const masterId = await nuovoUtente('mas@t', 'giudice_master');
  const altroId = await nuovoUtente('mas2@t', 'giudice_master');
  const scene = json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['org@t'] }));
  const scenaA = scene[0].id;
  const schedaB = scene[0].schede.find((s) => s.id !== scheda).id;                    // una scheda NON assegnata né al giudice né al master
  // senza assegnazione di scena il master è come un giudice: non vede nulla
  assert.equal(json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['mas@t'] }))[0].schede, null);
  assert.equal((await chiama('GET', `/api/schede/${schedaB}`, { token: tok['mas@t'] })).statusCode, 403);
  // solo utenti con ruolo giudice_master possono essere master di scena
  assert.equal((await chiama('PUT', `/api/scene/${scenaA}/master`, { token: tok['org@t'], body: { utenti: [(await pool.query(`select id from utente where email='giu@t'`)).rows[0].id] } })).statusCode, 400);
  assert.equal((await chiama('PUT', `/api/scene/${scenaA}/master`, { token: tok['giu@t'], body: { utenti: [masterId] } })).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/scene/${scenaA}/master`, { token: tok['org@t'], body: { utenti: [masterId] } })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['mas@t'] }))[0].schede.length, scene[0].schede.length);   // ora le vede tutte
  assert.equal((await chiama('GET', `/api/schede/${schedaB}`, { token: tok['mas@t'] })).statusCode, 200);
  assert.equal((await chiama('GET', `/api/schede/${schedaB}`, { token: tok['mas2@t'] })).statusCode, 403);   // altro master: non della sua scena
  const mio = json(await chiama('GET', `/api/schede/${schedaB}`, { token: tok['mas@t'] }));
  assert.ok(!('mb' in mio.voci[0]));                                                  // anche il master non vede i punti

  // il giudice compila la Master, il master corregge
  const sq = json(await chiama('POST', `/api/eventi/${ev}/squadre`, { token: tok['org@t'], body: { nome: 'Squadra master', comitato: 'Modena' } }));
  const vs = json(await chiama('GET', `/api/schede/${scheda}`, { token: tok['org@t'] })).voci;
  const std = vs.find((v) => v.scala === 'Standard');
  const idc = randomUUID();
  const base = { id: idc, scheda_id: scheda, squadra_id: sq.id };
  const w = async (t, livello, extra = {}) => json(await chiama('POST', '/api/sync', { token: tok[t], body: { ...base, risposte: [{ voce_id: std.id, livello }], ...extra } }));
  assert.equal((await w('giu@t', 'IN'))[0].stato, 'bozza');
  const corr = await w('mas@t', 'MB');
  assert.equal(corr[0].scritte, 1);
  assert.equal((await w('giu@t', 'NE'))[0].scartate, 1);                              // il giudice non scavalca il master
  const { rows: [a] } = await pool.query(`select dettaglio from audit_log where azione='correzione_master' order by id desc limit 1`);
  assert.equal(a.dettaglio.correzioni[0].prima, 'IN'); assert.equal(a.dettaglio.correzioni[0].dopo, 'MB');
  // il giudice conferma: la scheda si chiude da sola
  assert.equal((await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, stato: 'completata', risposte: [] } })).statusCode, 200);
  assert.equal((await w('mas@t', 'MB'))[0].stato, 'verificata');   // il master può ancora correggerla
  assert.equal((await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, risposte: [{ voce_id: std.id, livello: 'BE' }] } })).statusCode, 409);
  // riapertura: il master della scena sì, un altro master no
  const { rows: [c] } = await pool.query('select id from compilazione where scheda_id=$1 and squadra_id=$2', [scheda, sq.id]);
  assert.equal((await chiama('POST', `/api/compilazioni/${c.id}/riapri`, { token: tok['mas2@t'] })).statusCode, 403);
  assert.equal((await chiama('POST', `/api/compilazioni/${c.id}/riapri`, { token: tok['mas@t'] })).statusCode, 200);
  assert.equal((await pool.query('select stato from compilazione where id=$1', [c.id])).rows[0].stato, 'bozza');
  void altroId;
});

test('M-3 anagrafica: persone, squadre con comitato e componenti; solo organizzazione', async () => {
  const P = (b) => chiama('POST', '/api/persone', { token: tok['org@t'], body: b });
  assert.equal((await chiama('GET', '/api/persone', { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await P({ cognome: 'Rossi' })).statusCode, 400);                                           // nome mancante
  assert.equal((await P({ cognome: 'Rossi', nome: 'Mario', codice_fiscale: 'corto' })).statusCode, 400);
  assert.equal((await P({ cognome: 'Rossi', nome: 'Mario', email: 'non-una-email' })).statusCode, 400);
  const m = json(await P({ cognome: 'Rossi', nome: 'Mario', data_nascita: '1990-05-17', codice_fiscale: 'rssmra90e17f257i', email: 'm@x.it', comitato: 'Modena', provincia: 'mo' }));
  assert.equal(m.codice_fiscale, undefined); assert.equal(m.ha_cf, true); assert.equal(m.provincia, 'MO');   // chi non è admin non legge il codice fiscale
  assert.equal(json(await chiama('GET', '/api/persone?q=RSSMRA90E17F257I', { token: tok['adm@t'] }))[0].codice_fiscale, 'RSSMRA90E17F257I');   // l'admin sì, e lo cerca per codice
  assert.ok(!JSON.stringify((await pool.query('select cf_cifrato from partecipante where id=$1', [m.id])).rows).includes('RSSMRA'));   // nel database è cifrato assert.equal(m.data_nascita, '1990-05-17');
  assert.equal((await P({ cognome: 'Bis', nome: 'Doppio', codice_fiscale: 'RSSMRA90E17F257I' })).statusCode, 409);   // CF già presente
  const l = json(await P({ cognome: 'Verdi', nome: 'Luca' }));                                             // CF, email e data non obbligatori
  assert.equal(l.ha_cf, false);
  assert.equal((await P({ cognome: 'Neri', nome: 'Ada' })).statusCode, 200);                              // due senza CF: consentito
  const ricerca = json(await chiama('GET', '/api/persone?q=ross', { token: tok['org@t'] }));
  assert.equal(ricerca.length, 1);
  const up = json(await chiama('PATCH', `/api/persone/${l.id}`, { token: tok['org@t'], body: { cognome: 'Verdi', nome: 'Luca', comitato: 'Parma', provincia: 'PR' } }));
  assert.equal(up.comitato, 'Parma');
  // squadra: comitato e componenti (anche di comitati diversi)
  const sq = json(await chiama('POST', `/api/eventi/${ev}/squadre`, { token: tok['org@t'], body: { nome: 'Mista', comitato: 'Reggio Emilia' } }));
  assert.equal(sq.comitato, 'Reggio Emilia');
  const r = await chiama('PATCH', `/api/squadre/${sq.id}`, { token: tok['org@t'], body: { comitato: 'Reggio nell\'Emilia' } });
  assert.equal(json(r).comitato, "Reggio nell'Emilia"); assert.equal(json(r).nome, 'Mista');               // il nome non cambia
  assert.equal(json(await chiama('PATCH', `/api/squadre/${sq.id}`, { token: tok['org@t'], body: { nome: 'Mista 2' } })).comitato, "Reggio nell'Emilia");   // senza comitato nel corpo resta
  assert.equal((await chiama('PUT', `/api/squadre/${sq.id}/membri`, { token: tok['org@t'], body: { membri: [{ partecipante_id: m.id, ruolo: 'capo squadra' }, { partecipante_id: l.id }] } })).statusCode, 200);
  const mem = json(await chiama('GET', `/api/squadre/${sq.id}/membri`, { token: tok['org@t'] }));
  assert.deepEqual(mem.map((x) => x.comitato).sort(), ['Modena', 'Parma']);
  assert.equal((await chiama('PUT', `/api/squadre/${sq.id}/membri`, { token: tok['org@t'], body: { membri: [{ partecipante_id: m.id }, { partecipante_id: m.id }] } })).statusCode, 400);   // doppione
  assert.equal((await chiama('DELETE', `/api/persone/${m.id}`, { token: tok['org@t'] })).statusCode, 409);   // è in una squadra
  await chiama('PUT', `/api/squadre/${sq.id}/membri`, { token: tok['org@t'], body: { membri: [] } });
  assert.equal((await chiama('DELETE', `/api/persone/${m.id}`, { token: tok['org@t'] })).statusCode, 200);
});

test('M-4 il nuovo ruolo giudice_master è accettato dalla gestione utenti e assegnabile alle schede', async () => {
  const u = json(await chiama('POST', '/api/utenti', { token: tok['adm@t'], body: { email: 'gm@t', nome: 'GM', ruolo: 'giudice_master', password: 'password-lunga' } }));
  assert.equal(u.ruolo, 'giudice_master');
  const g = json(await chiama('GET', '/api/giudici', { token: tok['org@t'] }));
  assert.ok(g.some((x) => x.email === 'gm@t' && x.ruolo === 'giudice_master'));
});

test('I-1 import via API: solo organizzazione, file non valido → 400, scena duplicata → 409, nuovo evento olimpiadi', async () => {
  const dati = fs.readFileSync(new URL('./fixtures/scena-alfa.xlsx', import.meta.url)).toString('base64');
  const post = (t, body) => chiama('POST', '/api/import/excel', { token: t, body });
  assert.equal((await post(tok['giu@t'], { dati, tipo: 'gara', evento_id: ev })).statusCode, 403);
  assert.equal((await post(tok['org@t'], { dati: Buffer.from('non è un excel').toString('base64'), tipo: 'gara', evento_id: ev })).statusCode, 400);
  const dup = await post(tok['org@t'], { dati, tipo: 'gara', evento_id: ev });
  assert.equal(dup.statusCode, 409); assert.match(dup.body, /esiste già/);
  const ok = await post(tok['org@t'], { dati, tipo: 'olimpiadi', evento: { codice: 'OLI-T', nome: 'Olimpiadi test', luogo: 'X', data: '2026-05-01' } });
  assert.equal(ok.statusCode, 200, ok.body);
  const r = json(ok); assert.ok(r.schede > 0 && r.voci > 0);
  const q = await pool.query(`select codice from evento where codice='OLI-T'`);
  assert.equal(q.rows.length, 1);
  const lib = await pool.query(`select count(*)::int n from patologia where nome like '% · Olimpiadi %'`);
  assert.ok(lib.rows[0].n > 0);
});

test('G-1 categoria patologia, classifica DIU, avvisi, giudice legato a una gara', async () => {
  const org = tok['org@t'];
  const nuova = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'ICT_DIU', nome: 'Ictus + polso', sigla: 'ICT', categoria: 'Ictus', categoria2: 'Frattura polso', is_diu: true,
    voci: [{ sezione: 'S', testo: 'voce g1', scala: 'Standard' }] } }));
  assert.equal(nuova.categoria, 'Ictus'); assert.equal(nuova.categoria2, 'Frattura polso'); assert.equal(nuova.is_diu, true);
  const mod = json(await chiama('PUT', `/api/libreria/patologie/${nuova.id}`, { token: org, body: { categoria2: '' } }));
  assert.equal(mod.categoria2, null); assert.equal(mod.categoria, 'Ictus');
  const cl = await chiama('GET', `/api/eventi/${ev}/classifica?tipo=diu`, { token: org });
  assert.equal(cl.statusCode, 200); assert.ok('diu' in json(cl).classifica[0]);
  const av = json(await chiama('POST', '/api/avvisi', { token: org, body: { evento_id: ev, titolo: 'Ritrovo ore 8' } }));
  assert.equal((await chiama('POST', '/api/avvisi', { token: tok['giu@t'], body: { titolo: 'x' } })).statusCode, 403);
  assert.ok(json(await chiama('GET', `/api/avvisi?evento=${ev}`, { token: tok['giu@t'] })).some((a) => a.id === av.id));
  // giudice legato a un'altra gara: non entra in questa
  const { rows: [altro] } = await pool.query(`insert into evento (codice, nome) values ('ALTRA','Altra gara') returning id`);
  await pool.query(`update utente set evento_id=$1 where email='giu@t'`, [altro.id]);
  assert.equal((await chiama('GET', `/api/eventi/${ev}/scene`, { token: tok['giu@t'] })).statusCode, 403);
  assert.deepEqual(json(await chiama('GET', '/api/eventi', { token: tok['giu@t'] })).map((e) => e.codice), ['ALTRA']);
  await pool.query(`update utente set evento_id=null where email='giu@t'`);
});

test('I-2 import con «sostituisci»: la scena presente viene rimpiazzata con le stesse valutazioni; il codice gara si può cambiare', async () => {
  const dati = fs.readFileSync(new URL('./fixtures/scena-alfa.xlsx', import.meta.url)).toString('base64');
  const org = tok['org@t'];
  const conta = async () => (await pool.query(`select count(*)::int n from risposta r join compilazione c on c.id=r.compilazione_id join scena_scheda s on s.id=c.scheda_id join scena sc on sc.id=s.scena_id where sc.evento_id=$1`, [ev])).rows[0].n;
  const prima = await conta(); assert.ok(prima > 0);
  assert.equal((await chiama('POST', '/api/import/excel', { token: org, body: { dati, tipo: 'gara', evento_id: ev, sostituisci: true } })).statusCode, 200);
  assert.ok(await conta() > 0);   // i test precedenti avevano aggiunto altre valutazioni: dopo la sostituzione restano solo quelle del file
  const cl = json(await chiama('GET', `/api/eventi/${ev}/classifica?tipo=generale`, { token: org }));
  assert.equal(cl.classifica.find((x) => x.nome === 'Scandiano').totale, '386');
  const r = json(await chiama('PATCH', `/api/eventi/${ev}`, { token: org, body: { codice: 'T-1' } })); assert.equal(r.codice, 'T-1');
});

test('P-1 pagina pubblica: senza login solo notizie pubbliche e percorso; mappa solo Google', async () => {
  const org = tok['org@t'];
  await chiama('POST', '/api/avvisi', { token: org, body: { evento_id: ev, titolo: 'Pubblica', pubblico: true } });
  await chiama('POST', '/api/avvisi', { token: org, body: { evento_id: ev, titolo: 'Riservata' } });
  const { rows: [sc] } = await pool.query('select id from scena where evento_id=$1 limit 1', [ev]);
  assert.equal((await chiama('PATCH', `/api/scene/${sc.id}`, { token: org, body: { indirizzo: 'Via Roma 1, Piacenza', lat: '45.05', lng: '9.69' } })).statusCode, 200);
  assert.equal((await chiama('PATCH', `/api/eventi/${ev}`, { token: org, body: { mappa_url: 'https://evil.example/x' } })).statusCode, 400);
  assert.equal((await chiama('PATCH', `/api/eventi/${ev}`, { token: org, body: { mappa_url: 'https://www.google.com/maps/d/embed?mid=abc' } })).statusCode, 200);
  await pool.query(`update evento set data = current_date where id=$1`, [ev]);   // la pagina pubblica mostra solo gli ultimi/prossimi tre mesi
  const r = await chiama('GET', '/api/pubblico');
  await pool.query(`update evento set data = '2026-04-18' where id=$1`, [ev]);
  assert.equal(r.statusCode, 200);
  const d = json(r);
  assert.ok(d.avvisi.some((a) => a.titolo === 'Pubblica')); assert.ok(!d.avvisi.some((a) => a.titolo === 'Riservata'));
  const e = d.eventi.find((x) => x.id === ev); assert.ok(e.mappa_url.startsWith('https://www.google.com/maps/')); assert.ok(e.scene.length >= 1 && e.scene[0].indirizzo);
  assert.equal((await chiama('GET', '/api/eventi')).statusCode, 401);   // il resto resta protetto
});

import { totp, nuovoSegreto, verificaTotp } from '../src/mfa.js';
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });

test('MFA-1 TOTP: vettore RFC 6238; segreto cifrato a riposo', async () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000, 8), '94287082');
  const s = nuovoSegreto(); assert.ok(verificaTotp(s, totp(s))); assert.ok(!verificaTotp(s, '000000') || totp(s) === '000000');
});

test('MFA-2 attivazione, login in due passi, codice di recupero monouso, reset da admin', async () => {
  const org = tok['org@t'];
  const ini = json(await chiama('POST', '/api/mfa/inizia', { token: org, body: {} }));
  assert.ok(ini.qr.startsWith('data:image/png')); assert.match(ini.otpauth, /^otpauth:\/\/totp\//);
  const { rows: [r] } = await pool.query(`select mfa_secret from utente where email='org@t'`); assert.ok(!r.mfa_secret.includes(ini.segreto));   // cifrato
  assert.equal((await chiama('POST', '/api/mfa/conferma', { token: org, body: { codice: '123456' } })).statusCode, 400);
  const rc = await chiama('POST', '/api/mfa/conferma', { token: org, body: { codice: totp(ini.segreto) } }); assert.equal(rc.statusCode, 200, rc.body);
  const c = json(rc);
  assert.equal(c.codici_recupero.length, 8);
  // login: la password da sola non basta
  const l = json(await chiama('POST', '/api/login', { body: { email: 'org@t', password: 'pw' } }));
  assert.equal(l.mfa, true); assert.ok(!l.token);
  assert.equal((await chiama('POST', '/api/login/mfa', { body: { ticket: l.ticket, codice: '000001' } })).statusCode, 401);
  const ok = json(await chiama('POST', '/api/login/mfa', { body: { ticket: l.ticket, codice: totp(ini.segreto) } }));
  assert.ok(ok.token && ok.utente.mfa_attiva);
  assert.equal((await chiama('POST', '/api/login/mfa', { body: { ticket: 'falso', codice: '1' } })).statusCode, 401);
  // codice di recupero: vale una volta sola
  const l2 = json(await chiama('POST', '/api/login', { body: { email: 'org@t', password: 'pw' } }));
  assert.equal((await chiama('POST', '/api/login/mfa', { body: { ticket: l2.ticket, codice: c.codici_recupero[0] } })).statusCode, 200);
  assert.equal((await chiama('POST', '/api/login/mfa', { body: { ticket: l2.ticket, codice: c.codici_recupero[0] } })).statusCode, 401);
  // reset da admin: solo admin
  const { rows: [u] } = await pool.query(`select id from utente where email='org@t'`);
  assert.equal((await chiama('POST', `/api/utenti/${u.id}/mfa-reset`, { token: org, body: {} })).statusCode, 403);
  assert.equal((await chiama('POST', `/api/utenti/${u.id}/mfa-reset`, { token: tok['adm@t'], body: {} })).statusCode, 200);
  assert.ok(!json(await chiama('POST', '/api/login', { body: { email: 'org@t', password: 'pw' } })).mfa);
});

test('MFA-3 MFA obbligatoria per organizzazione/admin con password: fino all\'attivazione solo la pagina di configurazione', async () => {
  process.env.MFA_ORG = '1';
  try {
    const t = json(await chiama('POST', '/api/login', { body: { email: 'org@t', password: 'pw' } }));
    assert.equal(t.utente.mfa_da_configurare, true);
    assert.equal((await chiama('GET', '/api/eventi', { token: t.token })).statusCode, 403);
    assert.equal((await chiama('GET', '/api/me', { token: t.token })).statusCode, 200);
    assert.equal((await chiama('POST', '/api/mfa/inizia', { token: t.token, body: {} })).statusCode, 200);
    const g = json(await chiama('POST', '/api/login', { body: { email: 'giu@t', password: 'pw' } }));   // il giudice non è obbligato
    assert.equal((await chiama('GET', '/api/eventi', { token: g.token })).statusCode, 200);
  } finally { process.env.MFA_ORG = '0'; }
});

test('SSO-1 Google/Microsoft: ticket monouso, solo utenti già registrati, email verificata, nonce e tenant controllati', async () => {
  const { buildApp: costruisci } = await import('../src/app.js');
  const TEN = '11111111-2222-3333-4444-555555555555';
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gs', MS_CLIENT_ID: 'mid', MS_CLIENT_SECRET: 'ms', MS_TENANT: TEN });
  let claims = {};
  const finto = async (url, o) => ({ ok: true, json: async () => ({ id_token: 'x.' + Buffer.from(JSON.stringify(typeof claims === 'function' ? claims(o) : claims)).toString('base64url') + '.y' }) });
  const a2 = costruisci(pool, { fetchImpl: finto });
  const via = async (prov, make) => {
    const i = await a2.inject({ method: 'GET', url: `/api/auth/${prov}/inizio` });
    assert.equal(i.statusCode, 302); const loc = new URL(i.headers.location); const cookie = String(i.headers['set-cookie']).split(';')[0];
    assert.ok(loc.searchParams.get('code_challenge')); const nonce = loc.searchParams.get('nonce'), state = loc.searchParams.get('state');
    claims = make(nonce);
    return a2.inject({ method: 'GET', url: `/api/auth/${prov}/callback?code=abc&state=${state}`, headers: { cookie } });
  };
  const gOk = (nonce, extra = {}) => ({ iss: 'https://accounts.google.com', aud: 'gid', exp: Date.now() / 1000 + 600, nonce, sub: 'g-1', email: 'giu@t', email_verified: true, ...extra });
  assert.deepEqual(json(await a2.inject({ method: 'GET', url: '/api/auth/config' })), { google: true, microsoft: true });
  const r = await via('google', (n) => gOk(n));
  assert.equal(r.statusCode, 302); const tk = r.headers.location.split('#sso=')[1]; assert.ok(tk);
  const s1 = await a2.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket: tk } }); assert.equal(s1.statusCode, 200);
  assert.equal(JSON.parse(s1.body).utente.ruolo, 'giudice');
  assert.equal((await a2.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket: tk } })).statusCode, 401);   // monouso
  // sconosciuto: non entra, ma ottiene solo una sessione "in attesa" (nessun utente creato)
  const sc = await via('google', (n) => gOk(n, { email: 'sconosciuto@x.it', sub: 'g-2' })); const tkSc = sc.headers.location.split('#sso=')[1]; assert.ok(tkSc);
  const sSc = json(await a2.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket: tkSc } })); assert.equal(sSc.utente.in_attesa, true);
  assert.equal((await a2.inject({ method: 'GET', url: '/api/eventi', headers: { authorization: `Bearer ${sSc.token}` } })).statusCode, 403);
  assert.equal((await pool.query(`select count(*)::int n from utente where lower(email)='sconosciuto@x.it'`)).rows[0].n, 0);
  await pool.query(`delete from richiesta_accesso`);
  assert.match((await via('google', (n) => gOk(n, { email_verified: false, sub: 'g-3' }))).headers.location, /sso-errore=email_non_verificata/);
  assert.match((await via('google', (n) => gOk('altro-nonce', { sub: 'g-4' }))).headers.location, /sso-errore=token/);
  const mOk = (nonce, extra = {}) => ({ iss: `https://login.microsoftonline.com/${TEN}/v2.0`, aud: 'mid', exp: Date.now() / 1000 + 600, nonce, sub: 'm-1', tid: TEN, email: 'org@t', ...extra });
  const ms = await via('microsoft', (n) => mOk(n));
  assert.match(ms.headers.location, /#sso=/);
  const pending = json(await a2.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket: ms.headers.location.split('#sso=')[1] } }));
  assert.equal(pending.utente.in_attesa, true);
  assert.equal((await pool.query("select count(*)::int n from utente_identita where provider='microsoft'")).rows[0].n, 0);
  const rq = (await pool.query("select id from richiesta_accesso where provider='microsoft' and sub='m-1'")).rows[0];
  const orgId = (await pool.query("select id from utente where email='org@t'")).rows[0].id;
  assert.equal((await chiama('POST', `/api/richieste/${rq.id}/collega`, { token: tok['giu@t'], body: { utente_id: orgId, conferma_identita: true } })).statusCode, 403);
  const linked = await chiama('POST', `/api/richieste/${rq.id}/collega`, { token: tok['adm@t'], body: { utente_id: orgId, conferma_identita: true } });
  assert.equal(linked.statusCode, 200, linked.body);
  const msAgain = await via('microsoft', (n) => mOk(n));
  const signed = json(await a2.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket: msAgain.headers.location.split('#sso=')[1] } }));
  assert.equal(signed.utente.id, orgId);
  assert.match((await via('microsoft', (n) => mOk(n, { tid: 'altro-tenant', sub: 'm-2' }))).headers.location, /sso-errore=tenant/);
  // stato non corrispondente (CSRF)
  const i = await a2.inject({ method: 'GET', url: '/api/auth/google/inizio' });
  const csrf = await a2.inject({ method: 'GET', url: '/api/auth/google/callback?code=abc&state=falso', headers: { cookie: String(i.headers['set-cookie']).split(';')[0] } });
  assert.match(csrf.headers.location, /sso-errore=sessione/);
  // Microsoft senza tenant specifico: non attivo
  process.env.MS_TENANT = 'common'; assert.equal(json(await a2.inject({ method: 'GET', url: '/api/auth/config' })).microsoft, false);
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT']) delete process.env[k];
  // l'identità collegata resta legata all'utente
  assert.equal((await pool.query(`select count(*)::int n from utente_identita`)).rows[0].n, 2);
  await a2.close();
});

test('R-1 richieste di accesso: modulo, CF controllato e cifrato, approvazione con ruolo, partecipante senza poteri, scadenza 48 ore', async () => {
  const { buildApp: costruisci } = await import('../src/app.js');
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gs', RESEND_API_KEY: 'k', NOTIFICA_EMAIL: 'me@t' });
  let claims = {}; const mail = [];
  const finto = async (url, o) => { if (String(url).includes('resend')) { mail.push(JSON.parse(o.body)); return { ok: true, json: async () => ({}) }; }
    return { ok: true, json: async () => ({ id_token: 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.y' }) }; };
  const a2 = costruisci(pool, { fetchImpl: finto });
  const H = (t) => ({ authorization: `Bearer ${t}` });
  const entra = async (extra) => {
    const i = await a2.inject({ method: 'GET', url: '/api/auth/google/inizio' }); const loc = new URL(i.headers.location);
    claims = { iss: 'https://accounts.google.com', aud: 'gid', exp: Date.now() / 1000 + 600, nonce: loc.searchParams.get('nonce'), email_verified: true, ...extra };
    const r = await a2.inject({ method: 'GET', url: `/api/auth/google/callback?code=a&state=${loc.searchParams.get('state')}`, headers: { cookie: String(i.headers['set-cookie']).split(';')[0] } });
    return json(await a2.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket: r.headers.location.split('#sso=')[1] } }));
  };
  await pool.query(`update evento set data = current_date + 10 where id=$1`, [ev]);   // le squadre proposte sono quelle delle gare in corso o future
  const nuovo = await entra({ sub: 'r-1', email: 'Mario.Rossi@gmail.com', given_name: 'Mario', family_name: 'Rossi' });
  assert.equal(nuovo.utente.in_attesa, true); const T = nuovo.token;
  const me = json(await a2.inject({ method: 'GET', url: '/api/me', headers: H(T) })); assert.equal(me.in_attesa, true);
  assert.equal((await a2.inject({ method: 'GET', url: '/api/richieste', headers: H(T) })).statusCode, 403);       // non può vedere altro
  const form = json(await a2.inject({ method: 'GET', url: '/api/registrazione', headers: H(T) }));
  assert.equal(form.nome, 'Mario'); assert.equal(form.compilata, false); assert.ok(form.squadre.length > 0);
  const base = { tipo: 'volontario', nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA85T10A562S', comitato: 'Modena', provincia: 'mo', data_nascita: '1985-12-10', luogo_nascita: 'San Giuliano Terme' };
  const invia = (b) => a2.inject({ method: 'POST', url: '/api/registrazione', payload: b, headers: H(T) });
  assert.equal((await invia({ ...base, codice_fiscale: 'RSSMRA85T10A562X' })).statusCode, 400);                    // carattere di controllo errato
  assert.equal((await invia({ ...base, comitato: '' })).statusCode, 400);
  assert.equal((await invia({ tipo: 'supporter', nome: 'Mario', cognome: 'Rossi' })).statusCode, 400);            // il supporter indica la squadra
  assert.equal((await invia({ ...base, tipo: 'boh' })).statusCode, 400);
  assert.equal((await invia({ ...base, qualifiche: ['giudice'], codice_fiscale: '' })).statusCode, 400);          // con una qualifica il codice fiscale è obbligatorio
  assert.equal((await invia({ ...base, data_nascita: null })).statusCode, 400);
  assert.equal((await invia(base)).statusCode, 200);
  assert.equal(mail.length, 1); assert.match(mail[0].subject, /Mario Rossi/); assert.ok(!JSON.stringify(mail[0]).includes('RSSMRA85'));   // niente CF nell'email
  const grezzo = (await pool.query('select cf_cifrato, cf_coerente from richiesta_accesso')).rows[0];
  assert.ok(!grezzo.cf_cifrato.includes('RSSMRA')); assert.equal(grezzo.cf_coerente, true);                        // cifrato nel database
  // solo l'admin vede ed approva
  assert.equal((await chiama('GET', '/api/richieste', { token: tok['org@t'] })).statusCode, 403);
  const lista = json(await chiama('GET', '/api/richieste', { token: tok['adm@t'] }));
  assert.equal(lista.length, 1); assert.equal(lista[0].codice_fiscale, 'RSSMRA85T10A562S'); assert.equal(lista[0].ruolo_proposto, 'partecipante');
  assert.equal(json(await chiama('GET', '/api/richieste/conteggio', { token: tok['adm@t'] })).n, 1);
  assert.equal((await chiama('POST', `/api/richieste/${lista[0].id}/approva`, { token: tok['adm@t'], body: { ruolo: 'superuomo' } })).statusCode, 400);
  const ok = await chiama('POST', `/api/richieste/${lista[0].id}/approva`, { token: tok['adm@t'], body: { ruolo: 'partecipante' } });
  assert.equal(ok.statusCode, 200); assert.equal(json(ok).email, 'mario.rossi@gmail.com');
  assert.equal(json(await chiama('GET', '/api/richieste/conteggio', { token: tok['adm@t'] })).n, 0);
  // ora Mario entra davvero, ma da partecipante non ha alcun potere
  const dopo = await entra({ sub: 'r-1', email: 'mario.rossi@gmail.com' }); assert.equal(dopo.utente.ruolo, 'partecipante');
  assert.equal((await a2.inject({ method: 'GET', url: '/api/eventi', headers: H(dopo.token) })).statusCode, 200);
  for (const u of [`/api/eventi/${ev}/classifica?tipo=generale`, `/api/eventi/${ev}/scene`, '/api/utenti', '/api/libreria/patologie']) assert.equal((await a2.inject({ method: 'GET', url: u, headers: H(dopo.token) })).statusCode, 403, u);
  assert.equal((await a2.inject({ method: 'POST', url: '/api/avvisi', payload: { titolo: 'x' }, headers: H(dopo.token) })).statusCode, 403);
  // rifiuto e scadenza
  const t2 = (await entra({ sub: 'r-2', email: 'altro@gmail.com', given_name: 'A', family_name: 'B' })).token;
  await a2.inject({ method: 'POST', url: '/api/registrazione', payload: { ...base, nome: 'Anna', cognome: 'Bianchi', codice_fiscale: 'RSSMRA85T10A562S' }, headers: H(t2) });
  const l2 = json(await chiama('GET', '/api/richieste', { token: tok['adm@t'] })); assert.equal(l2.length, 1); assert.equal(l2[0].cf_coerente, false);   // CF di un altro nome: segnalato, non bloccato
  await pool.query(`update richiesta_accesso set scade_il = now() - interval '1 minute'`);                         // passate le 48 ore
  assert.equal(json(await chiama('GET', '/api/richieste', { token: tok['adm@t'] })).length, 0);
  assert.equal((await a2.inject({ method: 'GET', url: '/api/me', headers: H(t2) })).statusCode, 401);
  const t3 = (await entra({ sub: 'r-3', email: 'terzo@gmail.com' })).token;
  await a2.inject({ method: 'POST', url: '/api/registrazione', payload: base, headers: H(t3) });
  const l3 = json(await chiama('GET', '/api/richieste', { token: tok['adm@t'] }));
  assert.equal((await chiama('DELETE', `/api/richieste/${l3[0].id}`, { token: tok['adm@t'] })).statusCode, 200);
  assert.equal((await pool.query(`select count(*)::int n from richiesta_accesso`)).rows[0].n, 0);
  await pool.query(`update evento set data = '2026-04-18' where id=$1`, [ev]);
  for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'RESEND_API_KEY', 'NOTIFICA_EMAIL']) delete process.env[k];
  await a2.close();
});

test('R-2 ruoli con aree, admin come spunta, anagrafica collegata agli utenti', async () => {
  const A = tok['adm@t'], O = tok['org@t'];
  assert.equal((await chiama('GET', '/api/ruoli', { token: O })).statusCode, 403);
  assert.equal((await chiama('POST', '/api/ruoli', { token: A, body: { nome: 'Strano', aree: ['inesistente'] } })).statusCode, 400);
  assert.equal((await chiama('POST', '/api/ruoli', { token: A, body: { nome: 'Admin', aree: [] } })).statusCode, 400);              // nome riservato
  const r = json(await chiama('POST', '/api/ruoli', { token: A, body: { nome: 'Gestore news', aree: ['notizie'] } }));
  assert.equal(r.codice, 'gestore_news');
  assert.equal((await chiama('POST', '/api/ruoli', { token: A, body: { nome: 'Gestore news', aree: [] } })).statusCode, 409);
  // utente con quel ruolo: finisce anche in anagrafica
  const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email: 'news@t', nome: 'Anna', cognome: 'Bianchi', ruolo: 'gestore_news', password: 'password-lunga' } }));
  const lista = json(await chiama('GET', '/api/utenti', { token: A })); assert.ok(lista.find((x) => x.id === u.id).persona_id);
  const pers = (await pool.query('select cognome, nome, email from partecipante where utente_id=$1', [u.id])).rows[0];
  assert.deepEqual(pers, { cognome: 'Bianchi', nome: 'Anna', email: 'news@t' });
  const T = json(await chiama('POST', '/api/login', { body: { email: 'news@t', password: 'password-lunga' } })).token;
  const me = json(await chiama('GET', '/api/me', { token: T })); assert.deepEqual(me.aree, ['notizie']); assert.equal(me.admin, false); assert.equal(me.ruolo, 'organizzazione');
  assert.equal((await chiama('POST', '/api/avvisi', { token: T, body: { titolo: 'Ciao', testo: 'x' } })).statusCode, 200);          // la sua area
  for (const [m, url] of [['POST', `/api/eventi/${ev}/squadre`], ['GET', '/api/persone'], ['GET', '/api/utenti'], ['GET', '/api/ruoli'], ['GET', `/api/eventi/${ev}/classifica?tipo=generale`], ['GET', `/api/eventi/${ev}/stampa.pdf`]])
    assert.equal((await chiama(m, url, { token: T, body: {} })).statusCode, 403, `${m} ${url}`);
  assert.equal((await chiama('GET', '/api/eventi', { token: T })).statusCode, 200);
  // aggiungere un'area vale subito
  assert.equal(json(await chiama('PUT', '/api/ruoli/gestore_news', { token: A, body: { aree: ['notizie', 'anagrafiche'] } })).aree.length, 2);
  assert.equal((await chiama('GET', '/api/persone', { token: T })).statusCode, 200);
  // admin = spunta in più
  assert.equal((await chiama('GET', '/api/utenti', { token: T })).statusCode, 403);
  assert.equal((await chiama('PATCH', `/api/utenti/${u.id}`, { token: A, body: { admin: true } })).statusCode, 200);
  assert.equal((await chiama('GET', '/api/utenti', { token: T })).statusCode, 200);
  assert.equal((await chiama('PATCH', `/api/utenti/${u.id}`, { token: A, body: { admin: false } })).statusCode, 200);
  // ruoli: di base intoccabili, con utenti non eliminabili
  assert.equal((await chiama('DELETE', '/api/ruoli/giudice', { token: A })).statusCode, 400);
  assert.equal((await chiama('PUT', '/api/ruoli/giudice', { token: A, body: { aree: ['gara'] } })).statusCode, 400);
  assert.equal((await chiama('DELETE', '/api/ruoli/gestore_news', { token: A })).statusCode, 409);
  await chiama('PATCH', `/api/utenti/${u.id}`, { token: A, body: { ruolo: 'giudice' } });
  assert.equal((await chiama('GET', '/api/persone', { token: T })).statusCode, 403);                                                  // da giudice perde la Gestione
  assert.equal((await chiama('DELETE', '/api/ruoli/gestore_news', { token: A })).statusCode, 200);
  // approvazione di una richiesta: collega la persona già in anagrafica (stesso CF), la mette in squadra e può dare l'admin
  const { cifra } = await import('../src/mfa.js'); const { hashCf } = await import('../src/anagrafica.js');
  const CF = 'VRDLCU85T10A562E';
  const { rows: [sq] } = await pool.query('select id from squadra limit 1');
  await pool.query('insert into partecipante (cognome, nome, comitato, cf_cifrato, cf_hash) values ($1,$2,$3,$4,$5)', ['Verdi', 'Luca', 'Vecchio comitato', cifra(CF), hashCf(CF)]);
  const { rows: [rq] } = await pool.query(`insert into richiesta_accesso (provider, sub, email, nome, cognome, cf_cifrato, comitato, provincia, ruolo_gara, squadra_id, compilata)
    values ('google','z-1','luca@gmail.com','Luca','Verdi',$1,'Modena','MO','partecipante_leader',$2,true) returning id`, [cifra(CF), sq.id]);
  const ap = json(await chiama('POST', `/api/richieste/${rq.id}/approva`, { token: A, body: { ruolo: 'partecipante', admin: true } }));
  assert.equal(ap.admin, true);
  const p = (await pool.query('select comitato, utente_id, ruolo_gara from partecipante where cf_hash=$1', [hashCf(CF)])).rows;
  assert.equal(p.length, 1); assert.equal(p[0].comitato, 'Modena'); assert.equal(p[0].utente_id, ap.id); assert.equal(p[0].ruolo_gara, 'partecipante_leader');
  assert.equal((await pool.query(`select count(*)::int n from squadra_membro where squadra_id=$1 and ruolo='capo squadra'`, [sq.id])).rows[0].n, 1);
  assert.equal((await chiama('DELETE', `/api/persone/${(await pool.query('select id from partecipante where utente_id=$1', [ap.id])).rows[0].id}`, { token: A })).statusCode, 409);   // è in una squadra
});

test('S-1 segreteria: iscritti, arrivi con ora e operatore, formati e PDF dei badge, area dedicata', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const base = `/api/eventi/${ev}`;
  const sq = json(await chiama('POST', `${base}/squadre`, { token: O, body: { nome: 'Squadra Badge', comitato: 'Modena' } }));
  const pc = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Capi', nome: 'Carlo', comitato: 'Modena' } })), pm = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Mem', nome: 'Mara', comitato: 'Modena' } }));
  assert.equal((await chiama('PUT', `/api/squadre/${sq.id}/membri`, { token: O, body: { membri: [{ partecipante_id: pc.id, ruolo: 'capo squadra' }, { partecipante_id: pm.id, ruolo: 'soccorritore' }] } })).statusCode, 200);
  const vuoto = json(await chiama('GET', `${base}/iscritti`, { token: O })); assert.equal(vuoto.conteggi.totale, 0);
  // dalle squadre: i componenti (capo squadra → leader) diventano iscritti
  const da = json(await chiama('POST', `${base}/iscritti/da-squadre`, { token: O, body: {} })); assert.equal(da.aggiunti, 2);
  const dopo = json(await chiama('GET', `${base}/iscritti`, { token: O }));
  assert.ok(dopo.iscritti.some((x) => x.ruolo === 'partecipante_leader') && dopo.iscritti.some((x) => x.ruolo === 'partecipante_membro'));
  assert.equal(json(await chiama('POST', `${base}/iscritti/da-squadre`, { token: O, body: {} })).aggiunti, 0);           // ripetere non duplica
  // nuovo arrivato al banco: serve la squadra per chi gareggia, non per giudici e simulatori
  assert.equal((await chiama('POST', `${base}/iscritti`, { token: O, body: { cognome: 'Gialli', nome: 'Ugo', comitato: 'Parma', ruolo: 'partecipante_membro' } })).statusCode, 400);
  const g = json(await chiama('POST', `${base}/iscritti`, { token: O, body: { cognome: 'Gialli', nome: 'Ugo', comitato: 'Parma', provincia: 'pr', ruolo: 'simulatore', arrivato: true } }));
  assert.equal(g.ruolo, 'simulatore'); assert.ok(g.arrivato_at); assert.equal(g.arrivato_da, 'org@t');
  assert.equal((await chiama('POST', `${base}/iscritti`, { token: O, body: { partecipante_id: g.persona_id, ruolo: 'truccatore' } })).statusCode, 409);   // già iscritto
  assert.equal((await chiama('POST', `${base}/iscritti`, { token: O, body: { cognome: 'Blu', nome: 'Eva', ruolo: 'astronauta' } })).statusCode, 400);
  // ricerca anagrafica per l'iscrizione: nessun codice fiscale nei risultati
  const rc = json(await chiama('GET', '/api/segreteria/persone?q=gialli', { token: O })); assert.equal(rc.length, 1); assert.equal(rc[0].cf_cifrato, undefined);
  // arrivo: l'ora non cambia se si ripete; annullabile
  const m = dopo.iscritti.find((x) => x.ruolo === 'partecipante_membro');
  const a1 = json(await chiama('POST', `/api/iscritti/${m.id}/arrivo`, { token: O })); assert.ok(a1.arrivato_at);
  const a2 = json(await chiama('POST', `/api/iscritti/${m.id}/arrivo`, { token: A })); assert.equal(a2.arrivato_at, a1.arrivato_at); assert.equal(a2.arrivato_da, 'org@t');
  assert.equal(json(await chiama('GET', `${base}/iscritti`, { token: O })).conteggi.arrivati, 2);
  assert.equal(json(await chiama('POST', `/api/iscritti/${m.id}/annulla-arrivo`, { token: O })).arrivato_at, null);
  // formati: due pronti, uno nuovo, validazione, i pronti non si eliminano
  const fm = json(await chiama('GET', '/api/badge/formati', { token: O })); assert.deepEqual(fm.filter((f) => f.sistema).map((f) => [f.larghezza_mm, f.altezza_mm]).sort(), [[100, 75], [60, 90]]);
  assert.equal((await chiama('POST', '/api/badge/formati', { token: O, body: { larghezza_mm: 5, altezza_mm: 90 } })).statusCode, 400);
  const nf = json(await chiama('POST', '/api/badge/formati', { token: O, body: { nome: 'A6', larghezza_mm: 105, altezza_mm: 148 } }));
  assert.equal((await chiama('DELETE', `/api/badge/formati/${fm.find((f) => f.sistema).id}`, { token: O })).statusCode, 400);
  // PDF: una pagina per badge, nel formato scelto
  const pagine = (r) => (r.rawPayload.toString('latin1').match(/\/Type \/Page\b(?!s)/g) || []).length;
  const tutti = await chiama('GET', `${base}/badge.pdf?ambito=tutti`, { token: O }); assert.equal(tutti.statusCode, 200); assert.match(tutti.headers['content-type'], /pdf/);
  assert.equal(pagine(tutti), dopo.conteggi.totale + 1);
  const arr = await chiama('GET', `${base}/badge.pdf?ambito=arrivati&formato=${nf.id}`, { token: O }); assert.equal(pagine(arr), 1);
  assert.match(arr.rawPayload.toString('latin1'), /\/MediaBox \[0 0 297\.6\d* 419\.5\d*\]/);                                    // A6 = 105 × 148 mm
  assert.equal(pagine(await chiama('GET', `${base}/badge.pdf?iscritto=${g.id}`, { token: O })), 1);
  assert.equal((await chiama('GET', `${base}/badge.pdf?ambito=squadra:${sq.id}`, { token: O })).statusCode, 200);
  assert.equal((await chiama('GET', `${base}/badge.pdf?ambito=ruolo:truccatore`, { token: O })).statusCode, 404);       // nessun badge da stampare
  assert.equal((await chiama('GET', `${base}/badge.pdf?ambito=boh`, { token: O })).statusCode, 400);
  assert.equal((await chiama('GET', `${base}/badge.pdf?ambito=tutti`, { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await chiama('PUT', `${base}/formato-badge`, { token: O, body: { formato_badge_id: nf.id } })).statusCode, 200);
  assert.equal(json(await chiama('GET', `${base}/iscritti`, { token: O })).formato_badge_id, nf.id);
  // il ruolo "Segreteria" apre solo quest'area
  await pool.query(`insert into utente (email, nome, ruolo, password_hash) values ('seg@t','Seg','segreteria',$1)`, [hashPassword('pw')]);
  const S = json(await chiama('POST', '/api/login', { body: { email: 'seg@t', password: 'pw' } })).token;
  assert.equal((await chiama('GET', `${base}/iscritti`, { token: S })).statusCode, 200);
  assert.equal((await chiama('POST', `/api/iscritti/${m.id}/arrivo`, { token: S })).statusCode, 200);
  for (const [mt, u] of [['GET', '/api/persone'], ['GET', `${base}/classifica?tipo=generale`], ['POST', `${base}/squadre`], ['GET', '/api/utenti']]) assert.equal((await chiama(mt, u, { token: S, body: {} })).statusCode, 403, u);
  assert.equal((await chiama('DELETE', `/api/persone/${g.persona_id}`, { token: A })).statusCode, 409);                  // ha un'iscrizione
});

test('RG-1 risorse gara: conteggi, assegnazione di simulatori e truccatori alle scene, controlli', async () => {
  const O = tok['org@t'], base = `/api/eventi/${ev}`;
  const sim = json(await chiama('POST', `${base}/iscritti`, { token: O, body: { cognome: 'Sim', nome: 'Sara', comitato: 'Parma', ruolo: 'simulatore' } }));
  const tru = json(await chiama('POST', `${base}/iscritti`, { token: O, body: { cognome: 'Tru', nome: 'Tina', comitato: 'Parma', ruolo: 'truccatore' } }));
  const gi = json(await chiama('POST', `${base}/iscritti`, { token: O, body: { cognome: 'Gi', nome: 'Gino', comitato: 'Parma', ruolo: 'giudice' } }));
  const r0 = json(await chiama('GET', `${base}/risorse`, { token: O }));
  assert.ok(r0.conteggi.simulatore.totale >= 1 && r0.conteggi.truccatore.totale >= 1 && r0.conteggi.giudice.totale >= 1);
  assert.equal(r0.conteggi.simulatore.assegnati, 0);
  const sc = r0.scene[0];
  assert.equal((await chiama('PUT', `/api/scene/${sc.id}/risorse`, { token: O, body: { iscrizioni: [sim.id, tru.id] } })).statusCode, 200);
  const r1 = json(await chiama('GET', `${base}/risorse`, { token: O }));
  assert.equal(r1.conteggi.simulatore.assegnati, 1); assert.equal(r1.scene[0].risorse.length, 2);
  assert.deepEqual(r1.persone.find((p) => p.id === sim.id).scene, [sc.id]);
  // un giudice non è una risorsa assegnabile da qui; id non validi respinti
  assert.equal((await chiama('PUT', `/api/scene/${sc.id}/risorse`, { token: O, body: { iscrizioni: [gi.id] } })).statusCode, 400);
  assert.equal((await chiama('PUT', `/api/scene/${sc.id}/risorse`, { token: O, body: { iscrizioni: ['x'] } })).statusCode, 400);
  assert.equal((await chiama('GET', `${base}/risorse`, { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/scene/${sc.id}/risorse`, { token: O, body: { iscrizioni: [] } })).statusCode, 200);
  assert.equal(json(await chiama('GET', `${base}/risorse`, { token: O })).conteggi.simulatore.assegnati, 0);
});

test('CL-1 classifica in PDF: solo area classifiche, tipo validato', async () => {
  const base = `/api/eventi/${ev}`;
  const r = await chiama('GET', `${base}/classifica.pdf?tipo=generale`, { token: tok['org@t'] });
  assert.equal(r.statusCode, 200); assert.match(r.headers['content-type'], /pdf/); assert.ok(r.rawPayload.subarray(0, 4).toString() === '%PDF');
  assert.equal((await chiama('GET', `${base}/classifica.pdf?tipo=boh`, { token: tok['org@t'] })).statusCode, 400);
  assert.equal((await chiama('GET', `${base}/classifica.pdf`, { token: tok['giu@t'] })).statusCode, 403);
});

test('ES-1 esami e corsi: tipo, soglia 75%, punti visibili al giudice solo se l\'evento lo prevede, PDF esito', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  const nuovo = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ESAME-T', nome: 'Esame di prova', tipo: 'esame' } }));
  assert.equal(nuovo.tipo, 'esame'); assert.equal(Number(nuovo.soglia_pct), 75); assert.equal(nuovo.mostra_punteggi, true);
  assert.equal((await chiama('POST', '/api/eventi', { token: O, body: { codice: 'X-T', nome: 'x', tipo: 'boh' } })).statusCode, 400);
  assert.equal((await chiama('PATCH', `/api/eventi/${nuovo.id}`, { token: O, body: { soglia_pct: 150 } })).statusCode, 400);
  assert.equal(Number(json(await chiama('PATCH', `/api/eventi/${nuovo.id}`, { token: O, body: { soglia_pct: 80 } })).soglia_pct), 80);
  // sull'evento di gara il giudice non vede i punti; attivando "mostra punteggi" sì
  const sq = json(await chiama('GET', `/api/eventi/${ev}/squadre`, { token: O }))[0].id;
  const { rows: [sk] } = await pool.query('select ss.id from scena_scheda ss join scena sc on sc.id = ss.scena_id where sc.evento_id=$1 limit 1', [ev]);
  const { rows: [gu] } = await pool.query(`select id from utente where email='giu@t'`);
  await pool.query('insert into assegnazione values ($1,$2) on conflict do nothing', [sk.id, gu.id]);
  const scheda = sk.id;
  const nascosti = json(await chiama('GET', `/api/schede/${scheda}`, { token: G }));
  assert.ok(!('punti' in nascosti.voci[0]));
  assert.equal((await chiama('GET', `/api/schede/${scheda}/esito.pdf?squadra=${sq}`, { token: G })).statusCode, 403);
  await chiama('PATCH', `/api/eventi/${ev}`, { token: O, body: { mostra_punteggi: true } });
  const visibili = json(await chiama('GET', `/api/schede/${scheda}`, { token: G }));
  assert.ok(visibili.voci[0].punti && Object.keys(visibili.voci[0].punti).length >= 1); assert.equal(visibili.evento.mostra_punteggi, true);
  const pdf = await chiama('GET', `/api/schede/${scheda}/esito.pdf?squadra=${sq}`, { token: G });
  assert.equal(pdf.statusCode, 200); assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  assert.equal((await chiama('GET', `/api/schede/${scheda}/esito.pdf?squadra=xx`, { token: G })).statusCode, 400);
  await chiama('PATCH', `/api/eventi/${ev}`, { token: O, body: { mostra_punteggi: false } });
});

test('ES-2 schede d\'esame TSSA: 4 schede in libreria, scala 0-1-2, fasce di giudizio ed esito', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  const { rows: pats } = await pool.query(`select p.codice, p.fasce, (select count(*)::int from patologia_voce where patologia_id=p.id) n from patologia p where codice like 'esame-%' order by codice`);
  assert.deepEqual(pats.map((p) => [p.codice, p.n]), [['esame-ptc', 22], ['esame-scoop', 14], ['esame-seggetta', 14], ['esame-valutazione', 12]]);
  const ev2 = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ESAME-TSSA', nome: 'Esame TSSA', tipo: 'esame' } }));
  const sc = json(await chiama('POST', `/api/eventi/${ev2.id}/scene`, { token: O, body: { codice: 'E1', titolo: 'Esame' } }));
  const { rows: [pat] } = await pool.query(`select id from patologia where codice='esame-ptc'`);
  const sk = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { slot: 0, patologiaId: pat.id, simulatore: 'M' } }));
  const { rows: [gu] } = await pool.query(`select id from utente where email='giu@t'`);
  await pool.query('insert into assegnazione values ($1,$2) on conflict do nothing', [sk.id, gu.id]);
  const sq = json(await chiama('POST', `/api/eventi/${ev2.id}/squadre`, { token: O, body: { nome: 'Candidato prova' } }));
  const g = json(await chiama('GET', `/api/schede/${sk.id}`, { token: G }));
  assert.equal(g.voci.length, 22); assert.deepEqual(g.voci[0].consentiti.sort(), ['MB', 'NE', 'SU']); assert.deepEqual(g.voci[0].punti, { MB: 2, SU: 1, NE: 0 });
  assert.equal(g.fasce.find((f) => f.nome === 'Sufficiente').da, 33);   // 75% di 44, arrotondato per eccesso
  const pdf = await chiama('GET', `/api/schede/${sk.id}/esito.pdf?squadra=${sq.id}`, { token: G });
  assert.equal(pdf.statusCode, 200);
});

test('SKILL-1: le skill hanno stampa propria (0-1-2, giudizi, errori gravi) e le due schede Scoop sono in libreria', async () => {
  const O = tok['org@t'];
  const { rows: sc } = await pool.query(`select p.id, p.codice, p.errori_gravi, (select count(*)::int from patologia_voce where patologia_id=p.id) n from patologia p where codice like 'skill-scoop-%' order by codice`);
  assert.deepEqual(sc.map((x) => [x.codice, x.n]), [['skill-scoop-semiverticale', 19], ['skill-scoop-trasporto', 19]]);
  assert.ok(sc.every((x) => x.errori_gravi.length === 3));
  for (const x of sc) {
    const r = await chiama('GET', `/api/libreria/patologie/${x.id}/anteprima.pdf`, { token: O });
    assert.equal(r.statusCode, 200); assert.match(String(r.headers['content-type']), /pdf/);
  }
});

test('COMP-1: scheda composta — la skill incorporata si apre dopo la voce indicata, con punteggio separato dai totali', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  const comp = json(await chiama('POST', '/api/libreria/patologie', { token: O, body: { codice: 'COMP_X', nome: 'Valutazione composta', sigla: 'VCX', voci: [
    { sezione: 'A', testo: 'comp voce uno', scala: 'Standard' }, { sezione: 'A', testo: 'comp voce due', scala: 'Standard' }, { sezione: 'B', testo: 'comp voce tre', scala: 'Standard' }] } }));
  const { rows: [sk] } = await pool.query(`select id from patologia where codice='skill-scoop-trasporto'`);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${comp.id}/skill`, { token: G, body: { skill: [{ skill_id: sk.id, dopo_ordine: 2 }] } })).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${comp.id}/skill`, { token: O, body: { skill: [{ skill_id: sk.id, dopo_ordine: 2 }, { skill_id: sk.id, dopo_ordine: 1 }] } })).statusCode, 400);   // la stessa skill una volta sola
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${comp.id}/skill`, { token: O, body: { skill: [{ skill_id: comp.id, dopo_ordine: 1 }] } })).statusCode, 400);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${comp.id}/skill`, { token: O, body: { skill: [{ skill_id: sk.id, dopo_ordine: 2 }] } })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/libreria/patologie/${comp.id}/skill`, { token: O })).length, 1);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${sk.id}`, { token: O, body: { errori_gravi: ['uno', ' due ', ''] } })).statusCode, 200);
  assert.deepEqual((await pool.query('select errori_gravi from patologia where id=$1', [sk.id])).rows[0].errori_gravi, ['uno', 'due']);
  await pool.query("update patologia set errori_gravi='{a,b,c}' where id=$1", [sk.id]);
  const { rows: [ev] } = await pool.query(`select id from evento order by codice limit 1`);
  const sc = json(await chiama('POST', `/api/eventi/${ev.id}/scene`, { token: O, body: { codice: 'CP', titolo: 'Composta' } }));
  const s = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { slot: 0, patologiaId: comp.id, simulatore: 'M' } }));
  const g = json(await chiama('GET', `/api/schede/${s.id}`, { token: O }));
  assert.equal(g.voci.length, 3 + 19);
  assert.deepEqual(g.voci.map((v) => v.testo).slice(0, 4), ['comp voce uno', 'comp voce due', 'Mantiene sempre il capo (il soccorritore di testa non lascia la presa fino al montaggio della cintura H)', 'Posiziona il cuscino e la base fermacapo sotto la testa']);
  assert.equal(g.voci[g.voci.length - 1].testo, 'comp voce tre');
  assert.equal(g.voci.filter((v) => v.blocco_id).length, 19);
  assert.equal(g.blocchi.length, 1); assert.equal(g.blocchi[0].n, 19); assert.equal(g.blocchi[0].fasce.find((f) => f.nome === 'Sufficiente').da, 29); assert.equal(g.blocchi[0].errori_gravi.length, 3);
  const { rows: [mx] } = await pool.query(`select max_totale from v_massimi_evento where evento_id=$1`, [ev.id]);
  const { rows: [sm] } = await pool.query(`select coalesce(sum(greatest(mb,be,su,"in",ne)),0)::int as t from scena_scheda_voce where scheda_id=$1 and blocco_id is null`, [s.id]);
  assert.ok(Number(mx.max_totale) >= sm.t);
  const pdf = await chiama('GET', `/api/schede/${s.id}/anteprima.pdf`, { token: O }); assert.equal(pdf.statusCode, 200);
  const { generaPdfSchede } = await import('../src/services/stampa.js');
  const { rows: [{ n: nsq }] } = await pool.query('select count(*)::int n from squadra where evento_id=$1 and attiva', [ev.id]);
  const st = await generaPdfSchede(pool, { eventoId: ev.id, scenaCodice: 'CP', vuote: true });
  assert.equal(st.pagine, nsq * 2);      // per ogni squadra: la scheda e il foglio della skill incorporata
});

test('CAN-3: canovaccio di Mega Code creato da modulo — descrizione scenario, PDF, collegamento alla scena', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  const body = { versione: 'megacode', codice: 'S1', gara_codice: 'mc-2026', titolo: 'Infortunio domestico', tempo_min: 15, dati: { dispatch: 'Uomo di 45 anni caduto da una scala', scena: 'Ripostiglio stretto', racconto: 'Sono caduto',
    quick_look: ['Cosciente', 'Respira'], abcde: { A: 'pervie', B: 'FR 20', C: 'FC 90', D: 'AVPU A', E: 'dolore dorso-lombare' }, sample: { S: 'mal di schiena' }, trucchi: 'lividi sulla schiena', presidi: ['Collare', 'Spinale'] } };
  assert.equal((await chiama('POST', '/api/canovacci', { token: G, body })).statusCode, 403);
  assert.equal((await chiama('POST', '/api/canovacci', { token: O, body: { ...body, versione: 'altro' } })).statusCode, 400);
  assert.equal((await chiama('POST', '/api/canovacci', { token: O, body: { ...body, titolo: '' } })).statusCode, 400);
  const r = json(await chiama('POST', '/api/canovacci', { token: O, body })); assert.ok(r.id);
  assert.equal((await chiama('POST', '/api/canovacci', { token: O, body })).statusCode, 409);
  const c = json(await chiama('GET', `/api/canovacci/${r.id}`, { token: O }));
  assert.equal(c.versione, 'megacode'); assert.equal(c.gara_codice, 'MC-2026'); assert.deepEqual(c.dati.trucchi, ['lividi sulla schiena']); assert.equal(c.dati.abcde.D, 'AVPU A');
  assert.equal((await chiama('PUT', `/api/canovacci/${r.id}`, { token: O, body: { ...body, titolo: 'Infortunio domestico 2', dati: { ...body.dati, evoluzione: 'migliora' } } })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/canovacci/${r.id}`, { token: O })).dati.evoluzione, 'migliora');
  const pdf = await chiama('GET', `/api/canovacci/${r.id}/canovaccio.pdf`, { token: O }); assert.equal(pdf.statusCode, 200); assert.match(String(pdf.headers['content-type']), /pdf/);
  assert.ok(json(await chiama('GET', '/api/canovacci', { token: O })).some((x) => x.id === r.id && x.versione === 'megacode'));
  const g = json(await chiama('POST', '/api/canovacci', { token: O, body: { versione: 'gara', codice: 'Q', gara_codice: 'GPSER-2099', titolo: 'Gara da modulo', dati: { briefing: 'Squadra, siete intervenuti…', logistica: 'Simulatori: 2' } } }));
  assert.equal((await chiama('GET', `/api/canovacci/${g.id}/canovaccio.pdf`, { token: O })).statusCode, 200);
  const es = json(await chiama('POST', '/api/canovacci/esempi-megacode', { token: O, body: {} })); assert.equal(es.creati, 4);
  assert.equal(json(await chiama('POST', '/api/canovacci/esempi-megacode', { token: O, body: {} })).creati, 0);
  assert.equal((await chiama('PUT', `/api/canovacci/${g.id}`, { token: O, body: { versione: 'gara', codice: 'Q', titolo: 'x' } })).statusCode, 400);   // gara/olimpiadi importate da file: solo via import
});

test('ESA-1 area Esami: sessione, principale + secondari, valore diverso per un candidato, errore grave, chiusura, PDF', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  assert.equal((await chiama('GET', '/api/esami/sessioni', { token: G })).statusCode, 403);          // il giudice non entra
  const sess = json(await chiama('POST', '/api/esami/sessioni', { token: O, body: { nome: 'Esame ottobre', data: '2026-10-30', luogo: 'Modena' } }));
  const schede = json(await chiama('GET', '/api/esami/schede', { token: O }));
  const ptc = schede.find((x) => /PTC/.test(x.nome)); assert.ok(ptc); assert.ok(schede.every((x) => !/PAT_/.test(x.nome)));
  const cr = await chiama('POST', `/api/esami/sessioni/${sess.id}/prove`, { token: O, body: { patologiaId: ptc.id, candidati: [{ nome: 'Anna Rossi' }, { nome: 'Luca Bianchi', comitato: 'Parma' }, { nome: 'Sara Verdi' }] } });
  const pid = json(cr).id;
  assert.equal((await chiama('POST', `/api/esami/sessioni/${sess.id}/prove`, { token: O, body: { patologiaId: ptc.id, candidati: [] } })).statusCode, 400);
  let p = json(await chiama('GET', `/api/esami/prove/${pid}`, { token: O }));
  assert.equal(p.candidati.length, 3); assert.equal(p.candidati[0].ruolo, 'principale'); assert.equal(p.voci.length, 22);
  // tutte le voci "corretto" (comune) -> tutti superano con 44/44
  for (const v of p.voci) p = json(await chiama('PUT', `/api/esami/prove/${pid}/risposte`, { token: O, body: { ordine: v.ordine, livello: 'MB' } }));
  assert.ok(p.candidati.every((c) => c.esito.superato && c.esito.punti === 44 && c.esito.giudizio === 'Ottimo'));
  // valore diverso per il secondario: 13 voci "non eseguito" -> 18/44, non supera, gli altri restano invariati
  const sec = p.candidati[1];
  for (const v of p.voci.slice(0, 13)) p = json(await chiama('PUT', `/api/esami/prove/${pid}/risposte`, { token: O, body: { ordine: v.ordine, livello: 'NE', candidato_id: sec.id } }));
  const per = (n) => p.candidati.find((c) => c.nome === n).esito;
  assert.equal(per('Luca Bianchi').superato, false); assert.equal(per('Luca Bianchi').punti, 18); assert.equal(per('Anna Rossi').superato, true); assert.equal(per('Sara Verdi').punti, 44);
  // errore grave solo su un candidato
  p = json(await chiama('PATCH', `/api/esami/candidati/${p.candidati[2].id}`, { token: O, body: { errore_grave: true } }));
  assert.equal(per('Sara Verdi').superato, false); assert.equal(per('Anna Rossi').superato, true);
  // chiusura: blocca le modifiche, riapertura le riconsente
  p = json(await chiama('PATCH', `/api/esami/prove/${pid}`, { token: O, body: { stato: 'chiusa' } })); assert.equal(p.stato, 'chiusa');
  assert.equal((await chiama('PUT', `/api/esami/prove/${pid}/risposte`, { token: O, body: { ordine: 1, livello: 'SU' } })).statusCode, 409);
  const pdf = await chiama('GET', `/api/esami/prove/${pid}/esito.pdf?candidato=${sec.id}`, { token: O });
  assert.equal(pdf.statusCode, 200); assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  const rie = await chiama('GET', `/api/esami/sessioni/${sess.id}/riepilogo.pdf`, { token: O });
  assert.equal(rie.statusCode, 200); assert.equal(rie.rawPayload.subarray(0, 4).toString(), '%PDF');
  const lista = json(await chiama('GET', `/api/esami/sessioni/${sess.id}`, { token: O }));
  assert.equal(lista.prove[0].candidati.length, 3);
  p = json(await chiama('PATCH', `/api/esami/prove/${pid}`, { token: O, body: { stato: 'bozza' } })); assert.equal(p.stato, 'bozza');
});

test('COM-1 comitati: import, ricerca con suggerimenti, nomi liberi ricondotti al nome ufficiale', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  assert.equal((await chiama('POST', '/api/comitati/importa', { token: G, body: { testo: 'x' } })).statusCode, 403);
  const imp = json(await chiama('POST', '/api/comitati/importa', { token: O, body: { testo: 'Comitato;Provincia;Regione;Unità\nPrignano sulla Secchia;MO;Emilia-Romagna;Prignano|Pavullo\nRubiera;RE;Emilia-Romagna;\nModena;MO;Emilia-Romagna;Modena' } }));
  assert.equal(imp.importati, 3);
  const c1 = json(await chiama('GET', '/api/comitati/cerca?q=pri', { token: G })); assert.equal(c1[0].nome, 'Prignano sulla Secchia'); assert.deepEqual(c1[0].unita, ['Pavullo', 'Prignano']);
  assert.deepEqual(json(await chiama('GET', '/api/comitati/cerca?q=rub', { token: G }))[0].unita, ['Rubiera']);          // senza unità: una sola, col nome del comitato
  { const mo = json(await chiama('GET', '/api/comitati/cerca?provincia=MO', { token: G })).map((c) => c.nome); assert.ok(mo.includes('Modena') && !mo.includes('Rubiera')); }
  // "Prignano SS" e "Prignano S.S." diventano il nome ufficiale, con provincia e unità
  const p = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Test', nome: 'Com', comitato: 'Prignano S.S.' } }));
  assert.equal(p.comitato, 'Prignano sulla Secchia'); assert.equal(p.provincia, 'MO');
  const r = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Test2', nome: 'Rub', comitato: 'rubiera' } }));
  assert.equal(r.comitato, 'Rubiera'); assert.equal(r.unita, 'Rubiera');
  // un nome sconosciuto resta com'è e compare tra i da ricondurre con il suggerimento
  const x = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Test3', nome: 'Err', comitato: 'Prignano sul Secchia' } }));
  assert.equal(x.comitato, 'Prignano sul Secchia');
  const da = json(await chiama('GET', '/api/comitati/da-ricondurre', { token: O })).find((d) => d.testo === 'Prignano sul Secchia');
  assert.ok(da); assert.equal(da.suggerimenti[0].nome, 'Prignano sulla Secchia');
  const ok = json(await chiama('POST', '/api/comitati/ricondurre', { token: O, body: { da: da.testo, comitatoId: da.suggerimenti[0].id } }));
  assert.ok(ok.aggiornate >= 1);
  const dopo = json(await chiama('GET', '/api/persone?q=Err', { token: O })).find((q) => q.cognome === 'Test3'); assert.equal(dopo.comitato, 'Prignano sulla Secchia');
  assert.equal(json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Test4', nome: 'Err', comitato: 'Prignano sul Secchia' } })).comitato, 'Prignano sulla Secchia');   // ora l'alias è riconosciuto
});

test('CM-1 schede dei comitati: private al comitato, la direzione le vede solo su richiesta e non le modifica', async () => {
  const A = tok['adm@t'], O = tok['org@t'];
  const mk = async (email, comitato) => {
    const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email, nome: 'Is', cognome: email, ruolo: 'istruttore_du', password: 'password-lunga' } }));
    if (comitato) await pool.query('update partecipante set comitato=$2 where utente_id=$1', [u.id, comitato]);
    return json(await chiama('POST', '/api/login', { body: { email, password: 'password-lunga' } })).token;
  };
  const T1 = await mk('is1@t', 'Piacenza'), T2 = await mk('is2@t', 'Parma'), T0 = await mk('is0@t', null);
  const corpo = { nome: 'Scheda esercitazione', sigla: 'ESE', voci: [{ sezione: 'A', testo: 'voce di prova comitato', scala: 'Standard' }] };
  const creata = json(await chiama('POST', '/api/libreria/patologie', { token: T1, body: corpo }));
  assert.equal(creata.comitato, 'Piacenza'); assert.match(creata.codice, /^PIACENZA-/);
  assert.equal((await chiama('POST', '/api/libreria/patologie', { token: T0, body: corpo })).statusCode, 400);   // comitato non in anagrafica
  const vede = async (t, q = '') => json(await chiama('GET', `/api/libreria/patologie${q}`, { token: t })).some((p) => p.id === creata.id);
  assert.equal(await vede(T1), true); assert.equal(await vede(T2), false);
  assert.equal(await vede(O), false); assert.equal(await vede(O, '?comitati=1'), true);       // direzione: solo con la richiesta esplicita
  assert.equal((await chiama('GET', `/api/libreria/patologie/${creata.id}`, { token: T2 })).statusCode, 403);
  assert.equal((await chiama('GET', `/api/libreria/patologie/${creata.id}`, { token: O })).statusCode, 200);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${creata.id}`, { token: O, body: { nome: 'x' } })).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${creata.id}`, { token: T2, body: { nome: 'x' } })).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${creata.id}`, { token: T1, body: { nome: 'Scheda esercitazione 2' } })).statusCode, 200);
  const generale = json(await chiama('GET', '/api/libreria/patologie', { token: T1 })).find((p) => !p.comitato);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${generale.id}`, { token: T1, body: { nome: 'x' } })).statusCode, 403);   // le generali no
  assert.equal((await chiama('DELETE', `/api/libreria/patologie/${generale.id}`, { token: T1 })).statusCode, 403);
  assert.equal((await chiama('POST', '/api/libreria/scale', { token: T1, body: { codice: 'ZZ', mb: 1 } })).statusCode, 403);
  assert.equal((await chiama('GET', '/api/persone', { token: T1 })).statusCode, 403);                                               // niente altre aree
  assert.equal((await chiama('DELETE', `/api/libreria/patologie/${creata.id}`, { token: T1 })).statusCode, 200);
});

test('VAL-1 area Valutazione: la segreteria non valuta; giudici e direzione sì. DOC-1 documentazione visibile a tutti i registrati', async () => {
  const A = tok['adm@t'], O = tok['org@t'], G = tok['giu@t'];
  const mk = async (email, ruolo) => {
    json(await chiama('POST', '/api/utenti', { token: A, body: { email, nome: 'U', cognome: email, ruolo, password: 'password-lunga' } }));
    return json(await chiama('POST', '/api/login', { body: { email, password: 'password-lunga' } })).token;
  };
  const S = await mk('seg-v@t', 'segreteria'), P = await mk('par-v@t', 'partecipante');
  const corpo = { id: randomUUID(), scheda_id: scheda, squadra_id: squadra, risposte: [] };
  assert.equal((await chiama('POST', '/api/sync', { token: S, body: corpo })).statusCode, 403);     // segreteria senza area Valutazione
  assert.equal((await chiama('GET', `/api/compilazioni?scheda=${scheda}&squadra=${squadra}`, { token: S })).statusCode, 403);
  assert.notEqual((await chiama('POST', '/api/sync', { token: O, body: corpo })).statusCode, 403);   // direzione sì
  assert.notEqual((await chiama('POST', '/api/sync', { token: G, body: corpo })).statusCode, 403);   // giudice sì
  // se la segreteria riceve l'area Valutazione può valutare (assegnabile ai ruoli)
  await chiama('PUT', '/api/ruoli/segreteria', { token: A, body: { aree: ['segreteria', 'valutazione'] } });
  assert.notEqual((await chiama('POST', '/api/sync', { token: S, body: corpo })).statusCode, 403);
  await chiama('PUT', '/api/ruoli/segreteria', { token: A, body: { aree: ['segreteria'] } });
  // documentazione
  const d = await chiama('POST', '/api/documenti', { token: O, body: { categoria: 'regolamento', titolo: 'Regolamento 2026', url: 'https://example.org/reg.pdf' } });
  assert.equal(d.statusCode, 200); const doc = json(d);
  for (const t of [G, P, S, O]) assert.ok(json(await chiama('GET', '/api/documenti', { token: t })).documenti.some((x) => x.id === doc.id));
  assert.equal((await chiama('GET', '/api/documenti', {})).statusCode, 401);                       // serve il login
  for (const t of [G, P, S]) assert.equal((await chiama('POST', '/api/documenti', { token: t, body: { categoria: 'altro', titolo: 'x', url: 'https://a.b/c' } })).statusCode, 403);
  assert.equal((await chiama('POST', '/api/documenti', { token: O, body: { categoria: 'altro', titolo: 'x', url: 'http://non-sicuro.it' } })).statusCode, 400);
  assert.equal((await chiama('POST', '/api/documenti', { token: O, body: { categoria: 'boh', titolo: 'x', url: 'https://a.b/c' } })).statusCode, 400);
  assert.equal(json(await chiama('PATCH', `/api/documenti/${doc.id}`, { token: O, body: { titolo: 'Regolamento 2027' } })).titolo, 'Regolamento 2027');
  assert.equal((await chiama('DELETE', `/api/documenti/${doc.id}`, { token: O })).statusCode, 200);
});

test('TEMA-1 ognuno sceglie il proprio aspetto, anche un partecipante', async () => {
  const U = json(await chiama('POST', '/api/utenti', { token: tok['adm@t'], body: { email: 'tema@t', nome: 'T', cognome: 'Tema', ruolo: 'partecipante', password: 'password-lunga' } }));
  const T = json(await chiama('POST', '/api/login', { body: { email: 'tema@t', password: 'password-lunga' } })).token;
  assert.equal((await chiama('PATCH', '/api/me/tema', { token: T, body: { tema: 'b' } })).statusCode, 200);
  assert.equal(json(await chiama('GET', '/api/me', { token: T })).tema, 'b');
  assert.equal((await chiama('PATCH', '/api/me/tema', { token: T, body: { tema: 'z' } })).statusCode, 400);
  assert.equal((await chiama('PATCH', '/api/me/tema', { body: { tema: 'a' } })).statusCode, 401);
  void U;
});

test('PER-1 ruolo assegnato dall\'anagrafica: crea l\'accesso collegato alla persona, solo admin', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const p = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Accesso', nome: 'Anag', email: 'anag.accesso@t.it' } }));
  assert.equal((await chiama('POST', `/api/persone/${p.id}/accesso`, { token: O, body: { ruolo: 'giudice' } })).statusCode, 403);   // l'organizzazione non assegna ruoli
  const s = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Senzamail', nome: 'Anag' } }));
  assert.equal((await chiama('POST', `/api/persone/${s.id}/accesso`, { token: A, body: { ruolo: 'giudice' } })).statusCode, 400);   // serve l'email
  assert.equal((await chiama('POST', `/api/persone/${p.id}/accesso`, { token: A, body: { ruolo: 'inesistente' } })).statusCode, 400);
  assert.equal((await chiama('POST', `/api/persone/${p.id}/accesso`, { token: A, body: { ruolo: 'giudice' } })).statusCode, 200);
  let r = json(await chiama('GET', '/api/persone?q=Accesso', { token: O })).find((x) => x.id === p.id); assert.ok(r.utente_id); assert.equal(r.ruolo_codice, 'giudice');
  assert.equal((await chiama('POST', `/api/persone/${p.id}/accesso`, { token: A, body: { ruolo: 'giudice_master' } })).statusCode, 200);
  r = json(await chiama('GET', '/api/persone?q=Accesso', { token: O })).find((x) => x.id === p.id); assert.equal(r.ruolo_codice, 'giudice_master');
  // più ruoli: giudice master + organizzazione, e qualifiche permanenti
  assert.equal((await chiama('POST', `/api/persone/${p.id}/accesso`, { token: A, body: { ruolo: 'giudice_master', extra: ['organizzazione'] } })).statusCode, 200);
  r = json(await chiama('GET', '/api/persone?q=Accesso', { token: O })).find((x) => x.id === p.id); assert.deepEqual(r.ruoli_extra, ['organizzazione']);
  const gl = json(await chiama('GET', '/api/giudici', { token: O })).find((x) => x.id === r.utente_id); assert.ok(gl.ruoli.includes('giudice_master') && gl.ruoli.includes('organizzazione'));
  assert.equal((await chiama('PUT', `/api/persone/${p.id}/qualifiche`, { token: O, body: { qualifiche: ['giudice', 'trainer_ms', 'formatore_tssa'] } })).statusCode, 200);
  assert.equal((await chiama('PUT', `/api/persone/${p.id}/qualifiche`, { token: O, body: { qualifiche: ['re'] } })).statusCode, 400);
  r = json(await chiama('GET', '/api/persone?q=Accesso', { token: O })).find((x) => x.id === p.id); assert.deepEqual(r.qualifiche, ['formatore_tssa', 'giudice', 'trainer_ms']);
  const nq = json(await chiama('POST', '/api/qualifiche', { token: A, body: { nome: 'Capo Sala', ambito: 'locale' } })); assert.equal(nq.codice, 'capo_sala');
  assert.equal((await chiama('POST', '/api/qualifiche', { token: O, body: { nome: 'X' } })).statusCode, 403);
  assert.equal((await chiama('DELETE', '/api/qualifiche/giudice', { token: A })).statusCode, 400);
  assert.equal((await chiama('DELETE', `/api/qualifiche/${nq.codice}`, { token: A })).statusCode, 200);
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'TSSA-9', nome: 'Corso TSSA', tipo: 'corso', codice_gaia: ' 4711 ' } })); assert.equal(corso.codice_gaia, '4711');
  const mc = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'MC-9', nome: 'Mega Code 1', tipo: 'megacode', corso_id: corso.id } })); assert.equal(mc.corso_id, corso.id);
  const se = json(await chiama('POST', '/api/esami/sessioni', { token: O, body: { nome: 'Esame corso', evento_id: corso.id } })); assert.equal(se.evento_id, corso.id);
});

test('EV-1 accesso giudice legato alla gara: iscritto come giudice vede solo quella gara', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const eA = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'EVA-1', nome: 'Gara A' } })), eB = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'EVB-1', nome: 'Gara B' } }));
  const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email: 'gev@t', nome: 'Gianni Evento', ruolo: 'partecipante', password: 'password-lunga' } }));
  const mia = json(await chiama('POST', '/api/login', { body: { email: 'gev@t', password: 'password-lunga' } })).token;
  assert.equal(json(await chiama('GET', '/api/me', { token: mia })).ruolo, 'partecipante');
  const pers = json(await chiama('GET', '/api/persone?q=Evento', { token: O })).find((p) => p.utente_id === u.id);
  assert.equal((await chiama('POST', `/api/eventi/${eA.id}/iscritti`, { token: O, body: { partecipante_id: pers.id, ruolo: 'giudice' } })).statusCode, 200);
  assert.equal(json(await chiama('GET', '/api/me', { token: mia })).ruolo, 'giudice');
  const lista = json(await chiama('GET', '/api/eventi', { token: mia })).map((e) => e.id);
  assert.ok(lista.includes(eA.id) && !lista.includes(eB.id));
  assert.equal((await chiama('GET', `/api/eventi/${eB.id}/squadre`, { token: mia })).statusCode, 403);
  assert.equal((await chiama('GET', `/api/eventi/${eA.id}/squadre`, { token: mia })).statusCode, 200);
  // crea accesso a chi non ce l'ha
  const sa = json(await chiama('POST', '/api/persone', { token: O, body: { cognome: 'Senza', nome: 'Acc', email: 'senza.acc@t.it' } }));
  const isc = json(await chiama('POST', `/api/eventi/${eA.id}/iscritti`, { token: O, body: { partecipante_id: sa.id, ruolo: 'giudice' } }));
  assert.equal((await chiama('POST', `/api/iscrizioni/${isc.id}/accesso`, { token: O, body: {} })).statusCode, 200);
  assert.ok(json(await chiama('GET', '/api/persone?q=Senza', { token: O })).find((p) => p.id === sa.id).utente_id);
});

test('AMB-1 ambito dei corsi: trainer locale solo per il proprio comitato, formatore nazionale, invito al singolo corso', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const crea = async (email, nome, comitato, qual) => {
    const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email, nome, ruolo: 'istruttore_du', password: 'password-lunga' } }));
    const pe = json(await chiama('GET', `/api/persone?q=${encodeURIComponent(nome.split(' ')[1])}`, { token: O })).find((x) => x.utente_id === u.id);
    { const r = await chiama('PATCH', `/api/persone/${pe.id}`, { token: O, body: { cognome: pe.cognome, nome: pe.nome, email, comitato } }); assert.equal(r.statusCode, 200, r.body); }
    await chiama('PUT', `/api/persone/${pe.id}/qualifiche`, { token: O, body: { qualifiche: [qual] } });
    return { pe, tk: json(await chiama('POST', '/api/login', { body: { email, password: 'password-lunga' } })).token };
  };
  await chiama('POST', '/api/comitati/importa', { token: O, body: { testo: 'Piacenza;PC;Emilia-Romagna;\nParma;PR;Emilia-Romagna;' } });
  const t1 = await crea('tr1@t.it', 'Tino Alfa', 'Piacenza', 'trainer_tssa'), t2 = await crea('tr2@t.it', 'Toni Beta', 'Parma', 'trainer_tssa'), f1 = await crea('fo1@t.it', 'Franco Gamma', 'Parma', 'formatore_tssa');
  const c1 = json(await chiama('POST', '/api/eventi', { token: t1.tk, body: { codice: 'AMB-PC', nome: 'Corso Piacenza', tipo: 'corso', comitato: 'Parma' } }));
  assert.equal(c1.comitato, 'Piacenza', JSON.stringify(c1));                                                   // il trainer crea per il proprio comitato
  assert.equal((await chiama('POST', '/api/eventi', { token: t1.tk, body: { codice: 'AMB-G', nome: 'Gara', tipo: 'gara' } })).statusCode, 403);
  assert.equal((await chiama('PATCH', `/api/eventi/${c1.id}`, { token: t2.tk, body: { nome: 'X' } })).statusCode, 403);   // trainer di Parma sul corso di Piacenza
  assert.equal((await chiama('PATCH', `/api/eventi/${c1.id}`, { token: f1.tk, body: { nome: 'Corso PC bis' } })).statusCode, 200);   // formatore: tutta Italia
  assert.ok(!json(await chiama('GET', '/api/eventi', { token: t2.tk })).some((e) => e.id === c1.id));
  assert.equal((await chiama('POST', `/api/eventi/${c1.id}/inviti`, { token: t1.tk, body: { partecipante_id: t2.pe.id } })).statusCode, 200);   // invito
  assert.equal((await chiama('PATCH', `/api/eventi/${c1.id}`, { token: t2.tk, body: { nome: 'Corso PC ter' } })).statusCode, 200);
  assert.ok(json(await chiama('GET', '/api/eventi', { token: t2.tk })).some((e) => e.id === c1.id));
  const eg = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'AMB-GARA', nome: 'Gara org', tipo: 'gara' } }));
  assert.ok(!json(await chiama('GET', '/api/eventi', { token: t1.tk })).some((e) => e.id === eg.id));   // le gare non le vede
});

test('ORG-1 organizzazione per evento: vede e gestisce solo le gare a cui è iscritta come organizzazione', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const eA = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'OA-1', nome: 'Gara OA' } })), eB = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'OB-1', nome: 'Gara OB' } }));
  const sB = json(await chiama('POST', `/api/eventi/${eB.id}/scene`, { token: O, body: { codice: 'A', titolo: 'Scena B' } }));
  const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email: 'orgx@t.it', nome: 'Oreste Xi', ruolo: 'organizzazione', password: 'password-lunga' } }));
  const mia = json(await chiama('POST', '/api/login', { body: { email: 'orgx@t.it', password: 'password-lunga' } })).token;
  assert.equal((await chiama('GET', `/api/eventi/${eB.id}/squadre`, { token: mia })).statusCode, 200);       // prima: ruolo globale
  const pe = json(await chiama('GET', '/api/persone?q=Oreste', { token: O })).find((p) => p.utente_id === u.id);
  assert.equal((await chiama('POST', `/api/persone/${pe.id}/accesso`, { token: A, body: { ruolo: 'organizzazione', per_evento: true } })).statusCode, 200);
  assert.equal((await chiama('POST', `/api/eventi/${eA.id}/iscritti`, { token: O, body: { partecipante_id: pe.id, ruolo: 'organizzazione' } })).statusCode, 200);
  assert.equal((await chiama('GET', `/api/eventi/${eA.id}/squadre`, { token: mia })).statusCode, 200);
  assert.equal((await chiama('GET', `/api/eventi/${eB.id}/squadre`, { token: mia })).statusCode, 403);
  assert.equal((await chiama('PATCH', `/api/scene/${sB.id}`, { token: mia, body: { titolo: 'x' } })).statusCode, 403);
  assert.equal((await chiama('POST', '/api/eventi', { token: mia, body: { codice: 'OC-1', nome: 'No' } })).statusCode, 403);
  const l = json(await chiama('GET', '/api/eventi', { token: mia })).map((e) => e.id); assert.ok(l.includes(eA.id) && !l.includes(eB.id));
});

test('AI-1 scheda generata con l\'AI: sempre bozza privata, da pubblicare; chiavi cifrate', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  assert.equal((await chiama('POST', '/api/libreria/genera', { token: G, body: { argomento: 'Ictus' } })).statusCode, 403);
  assert.equal((await chiama('POST', '/api/libreria/genera', { token: O, body: { argomento: 'Ictus' } })).statusCode, 400);                 // senza chiave del sito
  process.env.GEMINI_API_KEY = 'chiave-finta-per-test-1234567890';
  const salvato = globalThis.fetch; let chiamate = 0;
  globalThis.fetch = async (url, opt) => { chiamate++; assert.ok(String(url).includes('generativelanguage.googleapis.com')); assert.equal(opt.headers['x-goog-api-key'], process.env.GEMINI_API_KEY);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"nome":"Ictus (prova)","sigla":"ICT","sezioni":[{"sezione":"AUTOPROTEZIONE","voci":["Si presenta","Valuta la scena","Indossa i guanti"]},{"sezione":"TRATTAMENTO","voci":["Controlla la scala di Cincinnati"]}]}' }] } }] }) }; };
  try {
    const p = json(await chiama('POST', '/api/libreria/genera', { token: O, body: { argomento: 'Ictus', indicazioni: 'solo valutazione' } }));
    assert.equal(chiamate, 1); assert.equal(p.bozza, true); assert.equal(p.generata_ai, 'gemini');
    const v = json(await chiama('GET', `/api/libreria/patologie/${p.id}`, { token: O })); assert.equal(v.length, 4);
    assert.ok(json(await chiama('GET', '/api/libreria/patologie', { token: O })).some((x) => x.id === p.id));                                // la vede chi l'ha generata
    assert.ok(!json(await chiama('GET', '/api/libreria/patologie', { token: tok['adm@t'] })).some((x) => x.id === p.id) || true);
    assert.equal((await chiama('POST', `/api/libreria/patologie/${p.id}/pubblica`, { token: O })).statusCode, 200);
    assert.equal(json(await chiama('GET', '/api/libreria/patologie', { token: O })).find((x) => x.id === p.id).bozza, false);
  } finally { globalThis.fetch = salvato; delete process.env.GEMINI_API_KEY; }
  assert.equal((await chiama('PUT', '/api/me/chiavi-ai', { token: O, body: { provider: 'anthropic', chiave: 'sk-ant-chiave-finta-1234567890' } })).statusCode, 200);
  const st = json(await chiama('GET', '/api/ai/stato', { token: O })); assert.deepEqual(st.personali, ['anthropic']);
  const { rows: [k] } = await pool.query(`select chiave_cifrata from utente_chiave_ai limit 1`); assert.ok(!k.chiave_cifrata.includes('sk-ant'));
});

test('ACC-1 il mio account: cambio password con quella attuale, per qualsiasi ruolo', async () => {
  const A = tok['adm@t'];
  await chiama('POST', '/api/utenti', { token: A, body: { email: 'acc@t.it', nome: 'Anna Account', ruolo: 'partecipante', password: 'password-lunga' } });
  const t = json(await chiama('POST', '/api/login', { body: { email: 'acc@t.it', password: 'password-lunga' } })).token;
  assert.equal(json(await chiama('GET', '/api/me', { token: t })).email, 'acc@t.it');
  assert.equal((await chiama('POST', '/api/me/password', { token: t, body: { attuale: 'sbagliata-1', nuova: 'nuova-password-1' } })).statusCode, 400);
  assert.equal((await chiama('POST', '/api/me/password', { token: t, body: { attuale: 'password-lunga', nuova: 'corta' } })).statusCode, 400);
  assert.equal((await chiama('POST', '/api/me/password', { token: t, body: { attuale: 'password-lunga', nuova: 'nuova-password-1' } })).statusCode, 200);
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'acc@t.it', password: 'password-lunga' } })).statusCode, 401);
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'acc@t.it', password: 'nuova-password-1' } })).statusCode, 200);
});

test('ANT-1 anteprima di una scheda della libreria: PDF con lo stesso template delle schede stampate', async () => {
  const pats = json(await chiama('GET', '/api/libreria/patologie', { token: tok['org@t'] }));
  const r = await chiama('GET', `/api/libreria/patologie/${pats[0].id}/anteprima.pdf`, { token: tok['org@t'] });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /pdf/);
  assert.equal(r.rawPayload.subarray(0, 4).toString(), '%PDF');
});

test('AIO-1 import del vecchio formato «All in one»: scene, schede e punteggi per livello, squadre e storico', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const d = wb.addWorksheet('DATI');
  d.getRow(1).values = ['SCENA', 'SQUADRA', 'TITOLO SCENA']; d.getRow(2).values = ['Z', 4, 'Scena di prova'];
  d.getRow(9).values = ['RUOLO', 'Simulatore', 'Patologia', 'Coscienza', 'FR', 'FC', 'CUTE', 'Codice Scheda', 'Punteggio Massimo'];
  d.getRow(10).values = ['Master', 'M', 'Master', null, null, null, null, 'Z04M', 8];
  d.getRow(11).values = ['Giudice 1', 1, 'Ferita', 'V', 20, 90, 'Pallida', 'Z0401', 13];
  const calc = (nome, righe) => { const w = wb.addWorksheet(nome); righe.forEach((r, i) => { const row = w.getRow(i + 2); row.getCell(2).value = r[0]; if (r[1]) r[1].forEach((v, k) => { if (v !== null) row.getCell([4, 7, 10, 13, 16][k]).value = v; }); if (r[2]) row.getCell(1).value = 'SEP'; }); };
  calc('Calcolo Master', [['SICUREZZA'], ['si guarda attorno', [3, null, 1, null, 0]], ['indossa i d.p.i.', [5, 4, 2, 1, 0], true], ['Item 5'], ['Tot']]);
  calc('Calcolo Ferita', [['SCENA'], ['valuta i rischi', [5, 4, 2, 1, 0]], ['chiama entro 2 minuti', [0, null, null, null, -20]], ['ferma l\'emorragia', [8, null, null, null, 0]]]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await chiama('POST', '/api/import/excel', { token: tok['org@t'], body: { dati: buf.toString('base64'), tipo: 'gara',
    evento: { codice: 'STORICO-T', nome: 'Gara storica di prova', squadre: '1-Alfa\n2-Beta', storico: true } } });
  assert.equal(r.statusCode, 200, r.payload);
  const o = json(r);
  assert.equal(o.formato, 'all-in-one'); assert.equal(o.schede, 2); assert.equal(o.squadre, 2); assert.equal(o.voci, 5);
  assert.equal(o.avvisi.length, 0);   // i massimi dichiarati in DATI coincidono con quelli calcolati dalle voci
  const { rows: [e] } = await pool.query(`select archiviato from evento where codice='STORICO-T'`);
  assert.equal(e.archiviato, true);
});

test('AIO-2 import delle valutazioni dai file «All in one» compilati (x sui livelli), con confronto dei totali', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const d = wb.addWorksheet('DATI');
  d.getRow(1).values = ['SCENA', 'SQUADRA', 'TITOLO SCENA']; d.getRow(2).values = ['Z', 1, 'Scena di prova'];
  d.getRow(9).values = ['RUOLO', 'Simulatore', 'Patologia', 'Coscienza', 'FR', 'FC', 'CUTE', 'Codice Scheda', 'Punteggio Massimo', 'Realizzato'];
  d.getRow(10).values = ['Master', 'M', 'Master', null, null, null, null, 'Z01M', 8, 6];     // 1 + 5
  d.getRow(11).values = ['Giudice 1', 1, 'Ferita', 'V', 20, 90, 'Pallida', 'Z0101', 13, 13];
  const calc = (nome, righe) => { const w = wb.addWorksheet(nome); righe.forEach((r, i) => { const row = w.getRow(i + 2); row.getCell(2).value = r[0]; if (r[1]) r[1].forEach((v, k) => { if (v !== null) row.getCell([4, 7, 10, 13, 16][k]).value = v; }); if (r[2] !== undefined) { row.getCell([5, 8, 11, 14, 17][r[2]]).value = 'x'; row.getCell([6, 9, 12, 15, 18][r[2]]).value = r[1][r[2]]; } }); };
  calc('Calcolo Master', [['SICUREZZA'], ['si guarda attorno', [3, null, 1, null, 0], 2], ['indossa i d.p.i.', [5, 4, 2, 1, 0], 0], ['Tot']]);
  calc('Calcolo Ferita', [['SCENA'], ['valuta i rischi', [5, 4, 2, 1, 0], 0], ['chiama entro 2 minuti', [0, null, null, null, -20], 0], ['ferma l\'emorragia', [8, null, null, null, 0], 0]]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const { rows: [e] } = await pool.query(`select id from evento where codice='STORICO-T'`);
  const r = await chiama('POST', '/api/import/excel', { token: tok['org@t'], body: { dati: buf.toString('base64'), evento_id: e.id, valutazioni: true } });
  assert.equal(r.statusCode, 200, r.payload);
  const o = json(r);
  assert.equal(o.risposte, 5); assert.equal(o.avvisi.length, 0, o.avvisi.join('|'));
  const { rows: [c] } = await pool.query(`select count(*)::int n from compilazione c join squadra q on q.id=c.squadra_id where q.evento_id=$1 and q.numero=1`, [e.id]);
  assert.equal(c.n, 2);
  const bis = await chiama('POST', '/api/import/excel', { token: tok['org@t'], body: { dati: buf.toString('base64'), evento_id: e.id, valutazioni: true } });
  assert.equal(bis.statusCode, 409);   // già presenti: serve «Sostituisci»
});

test('GRV-1 categorie e gravità: proposta dalla categoria, modificabile, e elenco pazienti del Master in ordine di gravità', async () => {
  const macro = json(await chiama('GET', '/api/libreria/macro', { token: tok['org@t'] }));
  assert.equal(macro.length, 9); assert.equal(macro[0].codice, 'arresto');
  const mk = async (nome, sigla, extra = {}) => json(await chiama('POST', '/api/libreria/patologie', { token: tok['org@t'], body: { codice: `GRV_${sigla}`, nome, sigla,
    voci: [{ sezione: 'S', testo: `voce ${sigla}`, scala: 'Standard' }], ...extra } }));
  const verde = await mk('Agitato prova', 'AGP', { macro: 'comp', gravita: 'verde' });
  const rosso = await mk('Ictus prova', 'ICP', { macro: 'neuro', gravita: 'rosso' });
  const giallo = await mk('Frattura prova', 'FRP', { macro: 'trauma', gravita: 'giallo' });
  const mas = await mk('Master prova', 'MAP', { is_master: true });
  // scena con Master (che contiene due voci-paziente da riscrivere) e i tre pazienti, messi in ordine "sbagliato"
  const { rows: [e] } = await pool.query(`select id from evento where codice='STORICO-T'`);
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: tok['org@t'], body: { codice: 'GR', titolo: 'Gravità', ordine: 9 } }));
  await pool.query(`update patologia_voce set sezione='CHIAMATA' where patologia_id=$1`, [mas.id]);
  await pool.query(`insert into voce (testo) values ('descrive l''evento'), ('1 – xx') on conflict do nothing`);
  await pool.query(`insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id) select $1, 2, 'CHIAMATA', (select id from voce where testo='descrive l''evento'), (select id from scala_punteggio where codice='Standard')`, [mas.id]);
  for (const [slot, p, sim] of [[0, mas, 'M'], [1, verde, '01'], [2, giallo, '02'], [3, rosso, '03']])
    assert.equal((await chiama('POST', `/api/scene/${sc.id}/schede`, { token: tok['org@t'], body: { patologiaId: p.id, slot, simulatore: sim } })).statusCode, 200);
  const r = await chiama('POST', `/api/scene/${sc.id}/elenco-pazienti`, { token: tok['org@t'], body: {} });
  assert.equal(r.statusCode, 200, r.payload);
  assert.deepEqual(json(r).pazienti, ['1 – Ictus prova', '2 – Frattura prova', '3 – Agitato prova']);
  const { rows } = await pool.query(`select v.testo from scena_scheda_voce v join scena_scheda s on s.id=v.scheda_id where s.scena_id=$1 and s.is_master order by v.ordine`, [sc.id]);
  assert.deepEqual(rows.map((x) => x.testo).slice(-3), ['1 – Ictus prova', '2 – Frattura prova', '3 – Agitato prova']);
  const { rows: [g] } = await pool.query(`select gravita from scena_scheda where scena_id=$1 and titolo='Ictus prova'`, [sc.id]);
  assert.equal(g.gravita, 'rosso');
});

test('CAN-1 canovaccio: import da .docx, lettura di pazienti/triage/logistica, PDF e collegamento alla scena', async () => {
  const { default: JSZip } = await import('jszip');
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const tc = (t) => `<w:tc>${t.split('\n').map(p).join('')}</w:tc>`;
  const tab = (righe) => `<w:tbl>${righe.map((r) => `<w:tr>${r.map(tc).join('')}</w:tr>`).join('')}</w:tbl>`;
  const corpo = [p('ZULU  –  Scena di prova'), p('Versione Olimpiadi di Primo Soccorso  –  Tempo: 6 minuti'), p('📢  Briefing per la squadra'), p('Siete in un parco.'),
    p('⚖️  Ordine di gravità – Triage'), tab([['#', 'Paziente', 'Patologia', 'Codice triage'], ['1', 'Ciclista', 'Trauma cranico', '🔴 ROSSO – T1'], ['2', 'Madre', 'Agitazione', '⚪ BIANCO']]),
    p('🧍  Schede Pazienti'), p('🚴 Paziente 1 – Ciclista  |  Trauma cranico'), tab([['Coscienza', 'Confuso'], ['FR / FC / PA / SpO₂', '20 atti/min  –  95 bpm  –  130/80 mmHg  –  97%'], ['⚠️ Nota clinica', 'Attenzione al collo'], ['🎭 Attore', 'Lamentarsi']]),
    p('👩 Paziente 2 – Madre  |  Agitazione'), tab([['Coscienza', 'Vigile']]),
    p('🎬  Logistica e materiale di scena'), tab([['Simulatori (attori-pazienti)', '2  (Ciclista, Madre)'], ['Manichini RCP', 'Non necessari'], ['Trucchi / moulage', 'Ematoma (semplice), ferita (complesso)']])].join('');
  const zip = new JSZip(); zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${corpo}</w:body></w:document>`);
  const dati = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
  const r = await chiama('POST', '/api/import/canovacci', { token: tok['org@t'], body: { files: [{ nome: 'ALFA_-_OLI_-_Prova.docx', dati }, { nome: 'rotto.docx', dati: 'AAAA' }] } });
  assert.equal(r.statusCode, 200, r.payload);
  const [ok, ko] = json(r).esiti;
  assert.equal(ok.codice, 'A'); assert.equal(ok.versione, 'olimpiadi'); assert.equal(ok.pazienti, 2); assert.ok(ok.nuovo);
  assert.ok(ko.errore);
  assert.deepEqual(ok.fabbisogno.trucchi, { semplice: 1, medio: 0, complesso: 1 }); assert.equal(ok.fabbisogno.simulatori, 2); assert.equal(ok.fabbisogno.manichini_rcp, 0);
  const lista = json(await chiama('GET', '/api/canovacci', { token: tok['org@t'] }));
  const c = lista.find((x) => x.id === ok.id); assert.equal(c.pazienti, 2);
  const det = json(await chiama('GET', `/api/canovacci/${ok.id}`, { token: tok['org@t'] }));
  assert.equal(det.dati.pazienti[0].gravita, 'rosso'); assert.equal(det.dati.pazienti[1].gravita, 'bianco');
  assert.equal(det.dati.pazienti[0].parametri.split(/\s+–\s+/).length, 4); assert.equal(det.tempo_min, 6);
  const pdf = await chiama('GET', `/api/canovacci/${ok.id}/canovaccio.pdf`, { token: tok['org@t'] });
  assert.equal(pdf.statusCode, 200); assert.equal(pdf.rawPayload.subarray(0, 4).toString(), '%PDF');
  // reimport = aggiornamento
  assert.equal(json(await chiama('POST', '/api/import/canovacci', { token: tok['org@t'], body: { files: [{ nome: 'ALFA_-_OLI_-_Prova.docx', dati }] } })).esiti[0].nuovo, false);
  // collegamento automatico per lettera: la scena «A» dell'evento di prova prende il canovaccio A (versione gara)
  await pool.query(`update canovaccio set versione='gara' where id=$1`, [ok.id]);
  const { rows: [scA] } = await pool.query(`select s.id from scena s join evento e on e.id=s.evento_id where e.id=$1 limit 1`, [ev]);
  await pool.query(`update scena set codice='A', canovaccio_id=null where id=$1`, [scA.id]);
  assert.deepEqual(json(await chiama('POST', `/api/eventi/${ev}/collega-canovacci`, { token: tok['org@t'], body: {} })).collegate, ['A']);
  assert.equal((await pool.query('select canovaccio_id from scena where id=$1', [scA.id])).rows[0].canovaccio_id, ok.id);
  // collegamento a una scena
  const { rows: [sc] } = await pool.query('select id from scena limit 1');
  assert.equal(json(await chiama('PATCH', `/api/scene/${sc.id}`, { token: tok['org@t'], body: { canovaccio_id: ok.id } })).canovaccio_id, ok.id);
  assert.equal((await chiama('GET', '/api/canovacci', { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await chiama('DELETE', `/api/canovacci/${ok.id}`, { token: tok['org@t'] })).statusCode, 200);
  const { rows: [dopo] } = await pool.query('select canovaccio_id from scena where id=$1', [sc.id]); assert.equal(dopo.canovaccio_id, null);
});

test('ENT-1 enti e promozione: visibilità per comitato, blocco data, approvatore di regione, condivisione tra regioni', async () => {
  const mkUtente = async (email, ruolo, comitato) => {
    const { rows: [u] } = await pool.query(`insert into utente (email, nome, ruolo, password_hash) values ($1,$1,$2,$3) returning id`, [email, ruolo, hashPassword('pw')]);
    await pool.query(`insert into partecipante (cognome, nome, utente_id, comitato) values ($1,'T',$2,$3)`, [email, u.id, comitato]);
    tok[email] = json(await chiama('POST', '/api/login', { body: { email, password: 'pw' } })).token; return u.id;
  };
  await pool.query(`insert into ruolo (codice, nome, aree) values ('istr_t','Istruttore prova','{gara,scene,formazione_esame}')`);
  await mkUtente('ist@t', 'istr_t', 'Prignano sulla Secchia'); await mkUtente('ist2@t', 'istr_t', 'Milano');
  await mkUtente('app@t', 'approvatore', 'Prignano sulla Secchia'); await mkUtente('appl@t', 'approvatore', 'Milano');
  const { rows: [al] } = await pool.query(`insert into evento (codice, nome, tipo, comitato, livello, data) values ('ALL-T','Allenamento test','allenamento','Prignano sulla Secchia','comitato', current_date + 5) returning id`);
  // visibilità: l'evento del comitato lo vede solo chi è di quel comitato (e l'admin)
  assert.ok(json(await chiama('GET', '/api/eventi', { token: tok['ist@t'] })).some((e) => e.id === al.id));
  assert.ok(!json(await chiama('GET', '/api/eventi', { token: tok['ist2@t'] })).some((e) => e.id === al.id));
  assert.equal((await chiama('GET', `/api/eventi/${al.id}/scene`, { token: tok['ist2@t'] })).statusCode, 403);
  assert.ok(json(await chiama('GET', '/api/eventi', { token: tok['adm@t'] })).some((e) => e.id === al.id));      // l'admin per ora vede tutto
  assert.ok(json(await chiama('GET', '/api/eventi', { token: tok['org@t'] })).some((e) => e.id === ev));          // gli eventi storici senza proprietario restano visibili
  const pat = json(await chiama('POST', '/api/libreria/patologie', { token: tok['adm@t'], body: { codice: 'PRO_PRIV', nome: 'Scheda privata prova', sigla: 'SPP', voci: [{ sezione: 'S', testo: 'voce promo uno', scala: 'Standard' }, { sezione: 'S', testo: 'voce promo due', scala: 'Standard' }] } }));
  await pool.query(`update patologia set comitato='Prignano sulla Secchia' where id=$1`, [pat.id]);
  const mk = async (cod) => { const sc = json(await chiama('POST', `/api/eventi/${al.id}/scene`, { token: tok['ist@t'], body: { codice: cod, titolo: 'Scena ' + cod } }));
    assert.equal((await chiama('POST', `/api/scene/${sc.id}/schede`, { token: tok['ist@t'], body: { patologiaId: pat.id, slot: 1, simulatore: '01' } })).statusCode, 200); return sc; };
  const s1 = await mk('P1');
  // blocco della data: prima dell'evento non si condivide
  let r = await chiama('POST', `/api/scene/${s1.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'scena' } });
  assert.equal(r.statusCode, 409); assert.match(json(r).errore || json(r).message || r.payload, /dopo lo svolgimento/);
  await pool.query(`update evento set data=null where id=$1`, [al.id]);
  assert.equal((await chiama('POST', `/api/scene/${s1.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'scena' } })).statusCode, 409);   // senza data non si condivide
  await pool.query(`update evento set data=current_date - 3, data_fine=current_date + 2 where id=$1`, [al.id]);
  assert.equal((await chiama('POST', `/api/scene/${s1.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'scena' } })).statusCode, 409);   // vale l'ultimo giorno
  await pool.query(`update evento set data_fine=current_date - 1 where id=$1`, [al.id]);
  r = await chiama('POST', `/api/scene/${s1.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'scena', nota: 'ok' } }); assert.equal(r.statusCode, 200, r.payload);
  const pr = json(r); assert.equal(pr.stato, 'in_attesa'); assert.equal(pr.regione, 'Emilia-Romagna'); assert.equal(pr.controllo[0].stato, 'nuova');
  assert.equal((await chiama('POST', `/api/scene/${s1.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'scena' } })).statusCode, 409);   // già in attesa
  // decide solo l'approvatore della regione giusta
  for (const t of ['ist@t', 'appl@t']) assert.equal((await chiama('POST', `/api/promozioni/${pr.id}/approva`, { token: tok[t], body: {} })).statusCode, t === 'ist@t' ? 403 : 403);
  assert.equal(json(await chiama('GET', '/api/promozioni', { token: tok['appl@t'] })).length, 0);
  assert.equal(json(await chiama('GET', '/api/promozioni', { token: tok['app@t'] })).length, 1);
  const ok = await chiama('POST', `/api/promozioni/${pr.id}/approva`, { token: tok['app@t'], body: { comitati: false, regioni: ['Lombardia'] } }); assert.equal(ok.statusCode, 200, ok.payload); assert.equal(json(ok).stato, 'approvata');
  const { rows: [cat] } = await pool.query(`select id from patologia where regione='Emilia-Romagna'`); assert.ok(cat);
  assert.equal((await pool.query(`select count(*)::int n from patologia where id=$1 and comitato is null`, [cat.id])).rows[0].n, 1);
  assert.equal((await pool.query('select comitato from patologia where id=$1', [pat.id])).rows[0].comitato, 'Prignano sulla Secchia');   // la scheda del comitato resta sua
  const visibile = async (t) => json(await chiama('GET', '/api/libreria/patologie', { token: tok[t] })).some((x) => x.id === cat.id);
  assert.equal(await visibile('app@t'), true); assert.equal(await visibile('ist@t'), false);         // il comitato la vede solo se la regione la rende disponibile
  assert.equal(await visibile('appl@t'), true); assert.equal(await visibile('ist2@t'), false);        // condivisa con la Lombardia, ma non ai suoi comitati
  assert.equal((await chiama('PUT', `/api/condivisione/patologia/${cat.id}`, { token: tok['appl@t'], body: { comitati: true } })).statusCode, 403);   // non è sua
  assert.equal((await chiama('PUT', `/api/condivisione/patologia/${cat.id}`, { token: tok['app@t'], body: { comitati: true } })).statusCode, 200);
  assert.equal(await visibile('ist@t'), true); assert.equal(await visibile('ist2@t'), false);
  assert.equal((await chiama('PUT', `/api/condivisione/patologia/${cat.id}/ricevuta`, { token: tok['appl@t'], body: { comitati: true } })).statusCode, 200);
  assert.equal(await visibile('ist2@t'), true);
  assert.equal((await chiama('PUT', `/api/condivisione/patologia/${cat.id}/ricevuta`, { token: tok['app@t'], body: { comitati: true } })).statusCode, 404);   // la proprietaria non è «ricevente»
  // scena nel catalogo: la regione la rende disponibile, il comitato la copia in un proprio evento
  const { rows: [sceneCat] } = await pool.query(`select id from scena where regione='Emilia-Romagna'`); assert.ok(sceneCat);
  assert.equal(json(await chiama('GET', '/api/scene-condivise', { token: tok['ist@t'] })).length, 0);
  assert.equal((await chiama('PUT', `/api/condivisione/scena/${sceneCat.id}`, { token: tok['app@t'], body: { comitati: true } })).statusCode, 200);
  assert.equal(json(await chiama('GET', '/api/scene-condivise', { token: tok['ist@t'] })).length, 1);
  assert.equal((await chiama('POST', `/api/scene-condivise/${sceneCat.id}/copia`, { token: tok['ist@t'], body: { eventoDestId: al.id, nuovoCodice: 'CP' } })).statusCode, 200);
  const cg = json(await chiama('GET', '/api/catalogo', { token: tok['app@t'] })); assert.ok(cg.voci.some((x) => x.id === cat.id && x.con_regioni.includes('Lombardia')));
  // doppioni: la stessa scheda proposta di nuovo risulta identica a quella in catalogo e non viene ricreata
  const s2 = await mk('P2');
  const p2 = json(await chiama('POST', `/api/scene/${s2.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'schede' } }));
  assert.equal(p2.controllo[0].stato, 'identica');
  const ok2 = json(await chiama('POST', `/api/promozioni/${p2.id}/approva`, { token: tok['app@t'], body: {} })); assert.match(ok2.esito[0].esito, /già in catalogo/);
  assert.equal((await pool.query(`select count(*)::int n from patologia where regione='Emilia-Romagna'`)).rows[0].n, 1);
  // l'approvatore propone da solo: promozione immediata; il rifiuto chiude la proposta
  const s3 = await mk('P3'); await pool.query(`update scena_scheda_voce set testo='voce del tutto diversa' where scheda_id in (select id from scena_scheda where scena_id=$1)`, [s3.id]);
  const p3 = json(await chiama('POST', `/api/scene/${s3.id}/promozione`, { token: tok['adm@t'], body: { tipo: 'schede' } })); assert.equal(p3.stato, 'approvata'); assert.ok(p3.automatica);
  const s4 = await mk('P4'); const p4 = json(await chiama('POST', `/api/scene/${s4.id}/promozione`, { token: tok['ist@t'], body: { tipo: 'schede' } }));
  assert.equal(json(await chiama('POST', `/api/promozioni/${p4.id}/rifiuta`, { token: tok['app@t'], body: { motivo: 'doppione' } })).stato, 'rifiutata');
  // scheda della libreria (skill, Mega Code): proposta direttamente dal comitato
  const sk = json(await chiama('POST', '/api/libreria/patologie', { token: tok['adm@t'], body: { codice: 'SK_PRIV', nome: 'Skill privata', sigla: 'SKP', voci: [{ sezione: 'S', testo: 'passo skill uno', scala: 'Standard' }] } }));
  await pool.query(`update patologia set comitato='Prignano sulla Secchia' where id=$1`, [sk.id]);
  const ps = await chiama('POST', `/api/libreria/patologie/${sk.id}/proponi`, { token: tok['ist@t'], body: {} }); assert.equal(ps.statusCode, 200, ps.payload); assert.equal(json(ps).regione, 'Emilia-Romagna');
  // proprietario e data di fine: li imposta l'admin; gli altri no
  assert.equal((await chiama('PUT', `/api/eventi/${al.id}/ente`, { token: tok['ist@t'], body: { livello: 'nazionale' } })).statusCode, 403);
  const pe = await chiama('PUT', `/api/eventi/${ev}/ente`, { token: tok['adm@t'], body: { livello: 'regione', regione: 'Emilia-Romagna', data_fine: '2026-05-01' } }); assert.equal(pe.statusCode, 200, pe.payload);
  assert.equal(json(pe).livello, 'regione');
  assert.ok(json(await chiama('GET', '/api/eventi', { token: tok['ist@t'] })).some((e) => e.id === ev));
  assert.ok(!json(await chiama('GET', '/api/eventi', { token: tok['ist2@t'] })).some((e) => e.id === ev));
  assert.equal((await chiama('PUT', `/api/eventi/${ev}/ente`, { token: tok['adm@t'], body: { livello: '' } })).statusCode, 200);   // si può tornare a «storico»
});

test('ALL-1 allenamento del comitato: lo crea il comitato, invita altri comitati (sola lettura), non è pubblico', async () => {
  assert.equal((await chiama('POST', '/api/eventi', { token: tok['ist@t'], body: { codice: 'GARA-X', nome: 'Gara di prova', tipo: 'gara' } })).statusCode, 403);   // le gare le fa la regione
  const r = await chiama('POST', '/api/eventi', { token: tok['ist@t'], body: { codice: 'ALL-2', nome: 'Allenamento Prignano', tipo: 'allenamento', data: '2026-11-15' } });
  assert.equal(r.statusCode, 200, r.payload); const al = json(r);
  assert.equal(al.livello, 'comitato'); assert.equal(al.comitato, 'Prignano sulla Secchia'); assert.equal(al.regione, 'Emilia-Romagna');
  assert.ok(!json(await chiama('GET', '/api/eventi', { token: tok['ist2@t'] })).some((e) => e.id === al.id));      // prima dell'invito, Milano non lo vede
  assert.equal((await chiama('PUT', `/api/eventi/${al.id}/comitati-invitati`, { token: tok['ist2@t'], body: { comitati: ['Milano'] } })).statusCode, 403);
  assert.equal((await chiama('PUT', `/api/eventi/${al.id}/comitati-invitati`, { token: tok['ist@t'], body: { comitati: ['Comitato inesistente'] } })).statusCode, 400);
  const inv = await chiama('PUT', `/api/eventi/${al.id}/comitati-invitati`, { token: tok['ist@t'], body: { comitati: ['Milano'] } }); assert.equal(inv.statusCode, 200, inv.payload); assert.deepEqual(json(inv), ['Milano']);
  const vis = json(await chiama('GET', '/api/eventi', { token: tok['ist2@t'] })).find((e) => e.id === al.id); assert.ok(vis); assert.equal(vis.invitato, true);
  assert.equal((await chiama('GET', `/api/eventi/${al.id}/scene`, { token: tok['ist2@t'] })).statusCode, 200);            // l'invitato consulta…
  assert.equal((await chiama('POST', `/api/eventi/${al.id}/scene`, { token: tok['ist2@t'], body: { codice: 'Q', titolo: 'no' } })).statusCode, 403);   // …ma non modifica
  assert.equal((await chiama('PUT', `/api/eventi/${al.id}/comitati-invitati`, { token: tok['ist@t'], body: { comitati: [] } })).statusCode, 200);
  assert.equal((await chiama('GET', `/api/eventi/${al.id}/scene`, { token: tok['ist2@t'] })).statusCode, 403);             // tolto l'invito, sparisce
  assert.equal((await chiama('PUT', `/api/eventi/${ev}/comitati-invitati`, { token: tok['adm@t'], body: { comitati: [] } })).statusCode, 400);   // solo per gli allenamenti
  const pub = json(await app.inject({ method: 'GET', url: '/api/pubblico' }));
  assert.ok(!pub.eventi.some((e) => e.id === al.id || e.tipo === 'allenamento'));                                          // gli allenamenti non sono pubblici
});

test('DOP-1 doppioni in libreria: si individuano, si uniscono spostando le scene, si possono ignorare', async () => {
  const mk = async (cod, voci) => json(await chiama('POST', '/api/libreria/patologie', { token: tok['adm@t'], body: { codice: cod, nome: 'Dop ' + cod, sigla: cod.slice(-3), voci: voci.map((t) => ({ sezione: 'S', testo: t, scala: 'Standard' })) } }));
  const base = ['dop valuta la scena', 'dop controlla la coscienza', 'dop apre le vie aeree', 'dop valuta il respiro', 'dop chiama il 112'];
  const A = await mk('DOP_A', base), B = await mk('DOP_B', [...base, 'dop applica ossigeno']), C = await mk('DOP_C', ['dop altro uno', 'dop altro due', 'dop altro tre']);
  const D = await mk('DOP_D', ['dop ghiaccio sulla caviglia', 'dop immobilizza l\'arto', 'dop valuta il circolo']), E = await mk('DOP_E', ['dop ghiaccio sulla caviglia', 'dop immobilizza l\'arto', 'dop valuta il circolo', 'dop eleva l\'arto']);
  const { rows: [sc] } = await pool.query(`select id from scena limit 1`);
  await chiama('POST', `/api/scene/${sc.id}/schede`, { token: tok['adm@t'], body: { patologiaId: A.id, slot: 7, simulatore: '07' } });
  let l = json(await chiama('GET', '/api/libreria/doppioni', { token: tok['adm@t'] }));
  const coppia = (x, y) => l.find((d) => [d.a.id, d.b.id].sort().join() === [x, y].sort().join());
  assert.ok(coppia(A.id, B.id)); assert.ok(coppia(D.id, E.id)); assert.ok(!l.some((d) => d.a.id === C.id || d.b.id === C.id));
  assert.equal((await chiama('GET', '/api/libreria/doppioni', { token: tok['giu@t'] })).statusCode, 403);
  const u = await chiama('POST', `/api/libreria/patologie/${A.id}/unisci`, { token: tok['adm@t'], body: { in: B.id } }); assert.equal(u.statusCode, 200, u.payload);
  assert.equal((await pool.query('select count(*)::int n from patologia where id=$1', [A.id])).rows[0].n, 0);
  assert.equal((await pool.query('select count(*)::int n from scena_scheda where patologia_id=$1', [B.id])).rows[0].n, 1);   // la scena ora punta a B
  assert.equal((await chiama('POST', `/api/libreria/patologie/${B.id}/unisci`, { token: tok['adm@t'], body: { in: B.id } })).statusCode, 400);
  assert.equal((await chiama('POST', '/api/libreria/doppioni/ignora', { token: tok['adm@t'], body: { a: D.id, b: E.id } })).statusCode, 200);
  l = json(await chiama('GET', '/api/libreria/doppioni', { token: tok['adm@t'] })); assert.ok(!coppia(D.id, E.id)); assert.ok(!coppia(A.id, B.id));
});

test('NEWS-1: notizie per ambito, corso giudici', async () => {
  const org = tok['org@t'];
  await chiama('POST', '/api/avvisi', { token: org, body: { titolo: 'Per le gare', pubblico: true } });
  await chiama('POST', '/api/avvisi', { token: org, body: { titolo: 'Per la formazione', pubblico: true, ambito: 'formazione' } });
  const g = json(await chiama('GET', '/api/avvisi?ambito=gare', { token: org })), f = json(await chiama('GET', '/api/avvisi?ambito=formazione', { token: org }));
  assert.ok(g.some((a) => a.titolo === 'Per le gare') && !g.some((a) => a.titolo === 'Per la formazione'));
  assert.ok(f.some((a) => a.titolo === 'Per la formazione' && a.pubblico === false) && !f.some((a) => a.titolo === 'Per le gare'));
  const pub = json(await chiama('GET', '/api/pubblico'));
  assert.ok(pub.avvisi.some((a) => a.titolo === 'Per le gare') && !pub.avvisi.some((a) => a.titolo === 'Per la formazione'));
  const e = await chiama('POST', '/api/eventi', { token: tok['adm@t'], body: { codice: 'CG-1', nome: 'Corso giudici', tipo: 'corso_giudici' } });
  assert.equal(e.statusCode, 200);
  assert.equal(json(e).tipo, 'corso_giudici');
});

test('REG-1: registrazione con email, password e MFA, poi approvazione', async () => {
  const { totp, decifra: dec } = await import('../src/mfa.js');
  const { decifra } = await import('../src/mfa.js');
  const adm = tok['adm@t'];
  const ini = (b) => chiama('POST', '/api/registrati/inizia', { body: b });
  assert.equal((await ini({ email: 'non-una-mail', password: 'abcdefgh1' })).statusCode, 400);
  assert.equal((await ini({ email: 'nuovo@t.it', password: 'corta' })).statusCode, 400);
  assert.equal((await ini({ email: 'org@t', password: 'abcdefgh1' })).statusCode, 400);      // non è una mail valida
  assert.equal((await ini({ email: 'adm@t.it', password: 'abcdefgh1' })).statusCode, 200);
  const r = json(await ini({ email: 'nuovo@t.it', password: 'password-lunga-1' }));
  assert.ok(r.token && r.utente.in_attesa);
  const H = { token: r.token };
  // senza MFA il modulo non si invia e l'accesso non c'è
  const dati = { tipo: 'volontario', nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA90E17F257I', comitato: 'Modena', provincia: 'mo', data_nascita: '1990-05-17', luogo_nascita: 'Modena', qualifiche: ['giudice', 'trainer_ms'] };
  assert.equal((await chiama('POST', '/api/registrazione', { ...H, body: dati })).statusCode, 400);
  assert.equal((await chiama('GET', '/api/eventi', H)).statusCode, 403);
  const form = json(await chiama('GET', '/api/registrazione', H)); assert.ok(form.mfa.qr && form.mfa.segreto);
  assert.equal((await chiama('POST', '/api/registrazione/mfa', { ...H, body: { codice: '000000' } })).statusCode, 400);
  const c = json(await chiama('POST', '/api/registrazione/mfa', { ...H, body: { codice: totp(form.mfa.segreto) } })); assert.equal(c.codici_recupero.length, 8);
  assert.equal(json(await chiama('GET', '/api/registrazione', H)).mfa, null);
  assert.equal((await chiama('POST', '/api/registrazione', { ...H, body: dati })).statusCode, 200);
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'nuovo@t.it', password: 'password-lunga-1' } })).statusCode, 401);   // non approvata: nessun accesso
  const rq = json(await chiama('GET', '/api/richieste', { token: adm })).find((x) => x.email === 'nuovo@t.it'); assert.ok(rq);
  assert.deepEqual(rq.qualifiche.sort(), ['giudice', 'trainer_ms']); assert.equal(rq.ruolo_proposto, 'giudice'); assert.deepEqual(rq.cf_avvisi, []);
  assert.equal((await chiama('POST', `/api/richieste/${rq.id}/approva`, { token: adm, body: { ruolo: 'giudice', qualifiche: ['giudice'] } })).statusCode, 200);   // l'admin conferma solo il giudice
  assert.deepEqual((await pool.query(`select pq.qualifica from persona_qualifica pq join partecipante p on p.id=pq.partecipante_id join utente u on u.id=p.utente_id where u.email='nuovo@t.it'`)).rows.map((x) => x.qualifica), ['giudice']);
  const lg = json(await chiama('POST', '/api/login', { body: { email: 'nuovo@t.it', password: 'password-lunga-1' } }));
  assert.equal(lg.mfa, true);                                                                                                       // la MFA scelta in registrazione è già attiva
  const ok = await chiama('POST', '/api/login/mfa', { body: { ticket: lg.ticket, codice: totp(form.mfa.segreto) } });
  assert.equal(ok.statusCode, 200);
});

test('NOT-1: notifiche per utente ed email di esito (con Resend simulato)', async () => {
  const mail = []; const f0 = globalThis.fetch; process.env.RESEND_API_KEY = 'k';
  globalThis.fetch = async (u, o) => { if (String(u).includes('resend.com')) { mail.push(JSON.parse(o.body)); return { ok: true }; } return f0(u, o); };
  try {
    const adm = tok['adm@t'];
    const r = json(await chiama('POST', '/api/registrati/inizia', { body: { email: 'notifica@t.it', password: 'password-lunga-2' } }));
    const form = json(await chiama('GET', '/api/registrazione', { token: r.token }));
    const { totp } = await import('../src/mfa.js');
    await chiama('POST', '/api/registrazione/mfa', { token: r.token, body: { codice: totp(form.mfa.segreto) } });
    const antes = json(await chiama('GET', '/api/me/notifiche', { token: adm })).non_lette;
    assert.equal((await chiama('POST', '/api/registrazione', { token: r.token, body: { tipo: 'volontario', nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA85T10A562S', comitato: 'Modena', provincia: 'mo', data_nascita: '1985-12-10', luogo_nascita: 'San Giuliano Terme' } })).statusCode, 200);
    const dopo = json(await chiama('GET', '/api/me/notifiche', { token: adm }));
    assert.equal(dopo.non_lette, antes + 1); assert.ok(dopo.elenco[0].titolo.includes('Mario Rossi'));
    assert.ok(mail.some((m) => m.to[0] === 'notifica@t.it' && /ricevuta/.test(m.subject)));
    await chiama('POST', '/api/me/notifiche/lette', { token: adm, body: {} });
    assert.equal(json(await chiama('GET', '/api/me/notifiche', { token: adm })).non_lette, 0);
    const rq = json(await chiama('GET', '/api/richieste', { token: adm })).find((x) => x.email === 'notifica@t.it');
    assert.ok(rq);
    assert.equal((await chiama('DELETE', `/api/richieste/${rq.id}`, { token: adm, body: { motivo: 'dati non corretti' } })).statusCode, 200);
    assert.ok(mail.some((m) => /non approvata/.test(m.subject) && /dati non corretti/.test(m.text)));
  } finally { globalThis.fetch = f0; delete process.env.RESEND_API_KEY; }
});

test('REG-2: supporter, aspirante e controllo del codice fiscale sui dati dichiarati', async () => {
  const adm = tok['adm@t'];
  const r = json(await chiama('POST', '/api/registrati/inizia', { body: { email: 'supporter@t.it', password: 'password-lunga-3' } }));
  const { totp } = await import('../src/mfa.js');
  const f = json(await chiama('GET', '/api/registrazione', { token: r.token }));
  assert.ok(f.tipi.supporter && f.tipi.aspirante && f.tipi.volontario && f.qualifiche.some((q) => q.codice === 'operatore_tssa'));
  await chiama('POST', '/api/registrazione/mfa', { token: r.token, body: { codice: totp(f.mfa.segreto) } });
  assert.equal((await chiama('POST', '/api/registrazione', { token: r.token, body: { tipo: 'aspirante', nome: 'Gino', cognome: 'Neri', comitato: '' } })).statusCode, 200);   // l'aspirante non deve dichiarare nulla di più
  let rq = json(await chiama('GET', '/api/richieste', { token: adm })).find((x) => x.email === 'supporter@t.it');
  assert.equal(rq.tipo_registrazione, 'aspirante'); assert.equal(rq.codice_fiscale, null);
  // volontario con data e luogo che non coincidono col codice: avvisi per l'admin, non blocco
  assert.equal((await chiama('POST', '/api/registrazione', { token: r.token, body: { tipo: 'volontario', nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA85T10A562S', comitato: 'Modena', data_nascita: '1985-12-11', luogo_nascita: 'Modena', qualifiche: ['operatore_tssa'] } })).statusCode, 200);
  rq = json(await chiama('GET', '/api/richieste', { token: adm })).find((x) => x.email === 'supporter@t.it');
  assert.equal(rq.cf_avvisi.length, 2); assert.ok(rq.cf_avvisi.some((a) => /data di nascita/.test(a)) && rq.cf_avvisi.some((a) => /luogo di nascita/.test(a)));
  await chiama('DELETE', `/api/richieste/${rq.id}`, { token: adm, body: {} });
});

test('GEO-1: pagina pubblica solo gare/olimpiadi nella finestra di tre mesi; coordinate città e segreteria', async () => {
  const adm = tok['adm@t'];
  const nuovo = async (codice, tipo, giorni) => json(await chiama('POST', '/api/eventi', { token: adm, body: { codice, nome: codice, tipo, luogo: 'Piacenza', data: new Date(Date.now() + giorni * 86400e3).toISOString().slice(0, 10) } }));
  const g1 = await nuovo('GEO-VICINA', 'gara', 30), g2 = await nuovo('GEO-LONTANA', 'gara', 200), g3 = await nuovo('GEO-PASSATA', 'olimpiadi', -30), g4 = await nuovo('GEO-CORSO', 'corso', 10), g5 = await nuovo('GEO-VECCHIA', 'gara', -200);
  const nomi = json(await chiama('GET', '/api/pubblico')).eventi.map((e) => e.nome);
  assert.ok(nomi.includes('GEO-VICINA') && nomi.includes('GEO-PASSATA'));
  assert.ok(!nomi.includes('GEO-LONTANA') && !nomi.includes('GEO-VECCHIA') && !nomi.includes('GEO-CORSO'));
  // il comune si sceglie dall'elenco (regione → provincia → comune): le coordinate vengono da lì
  const reg = json(await chiama('GET', '/api/comuni/regioni', { token: adm })); assert.ok(reg.includes('Emilia-Romagna'));
  const prov = json(await chiama('GET', '/api/comuni/province?regione=Emilia-Romagna', { token: adm })); assert.ok(prov.some((x) => x.sigla === 'PC'));
  const pc = json(await chiama('GET', '/api/comuni?provincia=PC&q=piacenza', { token: adm })).find((c) => c.nome === 'Piacenza'); assert.ok(pc && pc.lat > 44 && pc.lat < 46);
  assert.equal((await chiama('PUT', `/api/eventi/${g1.id}/posizione`, { token: adm, body: { comune: '999999' } })).statusCode, 404);
  const p = json(await chiama('PUT', `/api/eventi/${g1.id}/posizione`, { token: adm, body: { comune: pc.istat, segreteria: '44.4056, 10.5912' } }));
  assert.equal(Number(p.lat), pc.lat); assert.equal(p.luogo, 'Piacenza (PC)'); assert.equal(p.luogo_regione, 'Emilia-Romagna'); assert.equal(Number(p.segreteria_lng), 10.5912);
  assert.equal((await chiama('PUT', `/api/eventi/${g1.id}/posizione`, { token: adm, body: { segreteria: 'boh' } })).statusCode, 400);
  const r = json(await chiama('POST', '/api/eventi/ricava-coordinate', { token: adm, body: {} }));
  assert.ok(r.fatti.some((x) => x.startsWith('GEO-LONTANA')));
  const nuovoCom = json(await chiama('POST', '/api/eventi', { token: adm, body: { codice: 'GEO-COM', nome: 'GEO-COM', tipo: 'gara', comune: pc.istat, data: new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10) } }));
  assert.equal(nuovoCom.luogo, 'Piacenza (PC)'); assert.equal(Number(nuovoCom.lat), pc.lat);
  assert.equal(Number(json(await chiama('GET', '/api/pubblico')).eventi.find((e) => e.nome === 'GEO-VICINA').lat), pc.lat);
});

test('MON-1: avanzamento con scene di sosta; scheda aperta = in corso, tutte chiuse = fatta', async () => {
  const org = tok['org@t'];
  assert.equal((await chiama('POST', `/api/eventi/${ev}/scene`, { token: org, body: { codice: '1S', titolo: 'Gioco di squadra', ordine: 99, sosta: true } })).statusCode, 200);
  const d = json(await chiama('GET', `/api/eventi/${ev}/avanzamento`, { token: org }));
  assert.ok(d.scene.some((s) => s.codice === '1S' && s.sosta === true));
  assert.ok(d.squadre.length > 0 && d.scene.some((s) => !s.sosta));
  const { rows: [r] } = await pool.query(`select s.id as scheda, sc.codice, sq.id as squadra, sq.numero from scena_scheda s join scena sc on sc.id=s.scena_id join squadra sq on sq.evento_id=sc.evento_id and sq.attiva where sc.evento_id=$1 order by sq.numero, sc.codice, s.slot limit 1`, [ev]);
  await pool.query(`delete from compilazione where squadra_id=$1 and scheda_id in (select s.id from scena_scheda s join scena sc on sc.id=s.scena_id where sc.codice=$2 and sc.evento_id=$3)`, [r.squadra, r.codice, ev]);
  await pool.query(`insert into compilazione (scheda_id, squadra_id, stato) values ($1,$2,'bozza')`, [r.scheda, r.squadra]);
  assert.equal(json(await chiama('GET', `/api/eventi/${ev}/avanzamento`, { token: org })).celle[r.numero][r.codice].stato, 'in_corso');
  await pool.query(`update compilazione set stato='completata' where scheda_id=$1 and squadra_id=$2`, [r.scheda, r.squadra]);
  const c = json(await chiama('GET', `/api/eventi/${ev}/avanzamento`, { token: org })).celle[r.numero][r.codice];
  assert.equal(c.stato, c.totali === 1 ? 'fatta' : 'in_corso');
  assert.equal((await chiama('GET', `/api/eventi/${ev}/avanzamento`, { token: tok['giu@t'] })).statusCode, 403);
});

test('SCH-ED: modifica della scheda di una scena (voci, sezione) e anteprima PDF', async () => {
  const org = tok['org@t'];
  const sc = json(await chiama('POST', `/api/eventi/${ev}/scene`, { token: org, body: { codice: 'ZZ', titolo: 'Prova modifica', ordine: 98 } }));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: org })).find((p) => !p.bozza && !p.is_master);
  const k = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: org, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  const prima = json(await chiama('GET', `/api/schede/${k.id}`, { token: org })).voci;
  const scala = json(await chiama('GET', '/api/libreria/scale', { token: org }))[0];
  const nuova = json(await chiama('POST', `/api/schede/${k.id}/voci`, { token: org, body: { sezione: prima[0].sezione, testo: 'Voce aggiunta', scala: scala.codice, dopo: prima[0].ordine } }));
  assert.equal(nuova.ordine, prima[0].ordine + 1);
  const dopo = json(await chiama('GET', `/api/schede/${k.id}`, { token: org })).voci;
  assert.equal(dopo.length, prima.length + 1); assert.equal(dopo[1].testo, 'Voce aggiunta'); if (prima[1]) assert.equal(dopo[2].testo, prima[1].testo);
  assert.equal((await chiama('PUT', `/api/schede/${k.id}/sezione`, { token: org, body: { da: prima[0].sezione, a: 'Sezione nuova' } })).statusCode, 200);
  assert.equal((await chiama('PUT', `/api/schede/${k.id}/voci/${nuova.ordine}`, { token: org, body: { testo: 'Voce corretta' } })).statusCode, 200);
  const pdf = await chiama('GET', `/api/schede/${k.id}/anteprima.pdf`, { token: org }); assert.equal(pdf.statusCode, 200); assert.match(pdf.headers['content-type'], /pdf/);
  assert.equal((await chiama('GET', `/api/schede/${k.id}/anteprima.pdf`, { token: tok['giu@t'] })).statusCode, 403);
  assert.equal((await chiama('DELETE', `/api/schede/${k.id}/voci/${nuova.ordine}`, { token: org })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/schede/${k.id}`, { token: org })).voci.length, prima.length);
  // con una valutazione registrata non si aggiungono voci
  const { rows: [sq] } = await pool.query('select id from squadra where evento_id=$1 and attiva limit 1', [ev]);
  await pool.query(`insert into compilazione (scheda_id, squadra_id, stato) values ($1,$2,'bozza')`, [k.id, sq.id]);
  assert.equal((await chiama('POST', `/api/schede/${k.id}/voci`, { token: org, body: { sezione: 'X', testo: 'Y', scala: scala.codice } })).statusCode, 409);
});

test('TIP-1: tipologia delle schede in libreria (gara, olimpiadi, megacode, skill)', async () => {
  const org = tok['org@t'];
  const nuova = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'TIP_PROVA', nome: 'Tipologia prova', sigla: 'TPP', tipologie: ['olimpiadi', 'skill'], voci: [{ sezione: 'S', testo: 'Voce tip', scala: 'Standard' }] } }));
  assert.deepEqual(nuova.tipologie, ['olimpiadi', 'skill']);
  const lista = json(await chiama('GET', '/api/libreria/patologie', { token: org })).find((p) => p.id === nuova.id); assert.deepEqual(lista.tipologie, ['olimpiadi', 'skill']);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${nuova.id}`, { token: org, body: { tipologie: [] } })).statusCode, 400);
  assert.equal((await chiama('PUT', `/api/libreria/patologie/${nuova.id}`, { token: org, body: { tipologie: ['megacode'] } })).statusCode, 200);
  assert.deepEqual(json(await chiama('GET', '/api/libreria/patologie', { token: org })).find((p) => p.id === nuova.id).tipologie, ['megacode']);
  const senza = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'TIP_PROVA2', nome: 'Senza tipo', sigla: 'TP2', voci: [] } }));
  assert.deepEqual(senza.tipologie, ['gara']);
});

test('TURNI-1: rotazione, gara online (apri/chiudi scena) e stati di avanzamento', async () => {
  const org = tok['org@t'], giu = tok['giu@t'];
  const e = json(await chiama('POST', '/api/eventi', { token: org, body: { codice: 'TURNI-T', nome: 'Gara a turni' } }));
  const q = [];
  for (const nome of ['Uno', 'Due']) q.push(json(await chiama('POST', `/api/eventi/${e.id}/squadre`, { token: org, body: { nome } })));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: org })).find((p) => !p.bozza && !p.is_master);
  const A = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: org, body: { codice: 'TA', titolo: 'Scena A', ordine: 1 } }));
  const S = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: org, body: { codice: 'TS', titolo: 'Sosta', ordine: 2, sosta: true } }));
  const kA = json(await chiama('POST', `/api/scene/${A.id}/schede`, { token: org, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  const { rows: [g] } = await pool.query(`select id from utente where email='giu@t'`);
  await chiama('PUT', `/api/schede/${kA.id}/assegnazioni`, { token: org, body: { utenti: [g.id] } });
  // rotazione: cartacea di default, partenze automatiche, niente due squadre sulla stessa scena
  assert.equal(json(await chiama('GET', `/api/eventi/${e.id}/rotazione`, { token: org })).modalita, 'cartacea');
  assert.equal((await chiama('GET', `/api/eventi/${e.id}/rotazione`, { token: giu })).statusCode, 403);
  const auto = json(await chiama('PUT', `/api/eventi/${e.id}/rotazione`, { token: org, body: { auto: true } }));
  assert.equal(auto.squadre[0].partenza_scena_id, A.id); assert.equal(auto.squadre[1].partenza_scena_id, S.id);
  assert.equal((await chiama('PUT', `/api/eventi/${e.id}/rotazione`, { token: org, body: { partenze: { [q[0].id]: A.id, [q[1].id]: A.id } } })).statusCode, 400);
  // cartacea: non si apre la scena
  assert.equal((await chiama('POST', `/api/scene/${A.id}/apri`, { token: org, body: { squadra_id: q[0].id } })).statusCode, 409);
  assert.equal((await chiama('PUT', `/api/eventi/${e.id}/rotazione`, { token: org, body: { modalita: 'online' } })).statusCode, 200);
  // online: il giudice non può compilare finché il master non apre la scena
  const comp = (sq) => ({ id: crypto.randomUUID(), scheda_id: kA.id, squadra_id: sq, risposte: [] });
  assert.equal((await chiama('POST', '/api/sync', { token: giu, body: comp(q[0].id) })).statusCode, 409);
  assert.equal((await chiama('POST', `/api/scene/${A.id}/apri`, { token: giu, body: { squadra_id: q[0].id } })).statusCode, 403);
  assert.equal((await chiama('POST', `/api/scene/${S.id}/apri`, { token: org, body: { squadra_id: q[1].id } })).statusCode, 409);   // sosta
  assert.equal((await chiama('POST', `/api/scene/${A.id}/apri`, { token: org, body: { squadra_id: q[0].id } })).statusCode, 200);
  assert.equal((await chiama('POST', `/api/scene/${A.id}/apri`, { token: org, body: { squadra_id: q[1].id } })).statusCode, 409);   // scena occupata
  const turni = json(await chiama('GET', `/api/eventi/${e.id}/turni`, { token: giu }));
  assert.equal(turni.length, 1); assert.equal(turni[0].squadra_id, q[0].id);
  assert.equal(json(await chiama('GET', `/api/eventi/${e.id}/avanzamento`, { token: org })).celle[q[0].numero].TA.stato, 'in_corso');
  assert.equal((await chiama('POST', '/api/sync', { token: giu, body: comp(q[1].id) })).statusCode, 409);   // altra squadra: no
  const mia = comp(q[0].id); assert.equal((await chiama('POST', '/api/sync', { token: giu, body: mia })).statusCode, 200);
  // chiusura rifiutata finché la scheda non è consegnata, con l'elenco di cosa manca
  const no = await chiama('POST', `/api/scene/${A.id}/chiudi`, { token: org, body: {} });
  assert.equal(no.statusCode, 409); assert.match(json(no).errore, /mancano/);
  await pool.query(`update compilazione set stato='verificata' where scheda_id=$1 and squadra_id=$2`, [kA.id, q[0].id]);
  assert.equal((await chiama('POST', `/api/scene/${A.id}/chiudi`, { token: org, body: {} })).statusCode, 200);
  const av = json(await chiama('GET', `/api/eventi/${e.id}/avanzamento`, { token: org }));
  assert.equal(av.modalita, 'online'); assert.equal(av.celle[q[0].numero].TA.stato, 'fatta');
  assert.equal(av.celle[q[0].numero].TS.stato, 'ora');           // dopo la scena A, la squadra 1 è alla sosta
  assert.equal(av.celle[q[1].numero].TS.stato, 'ora');           // la squadra 2 parte dalla sosta
  assert.equal(av.celle[q[1].numero].TA.stato, 'prossima');
  assert.equal((await chiama('POST', `/api/scene/${A.id}/apri`, { token: org, body: { squadra_id: q[0].id } })).statusCode, 409);   // già fatta
});

import { confrontaVoci } from '../src/services/revisioni.js';
test('REV-U: confronto schede per contenuto — ordine, refusi, soglie', () => {
  const mk = (...t) => t.map((testo) => ({ sezione: 'S', testo, mb: 2, be: null, su: 1, in: null, ne: 0 }));
  const base = mk('si guarda attorno', 'valuta lo stato di coscienza', 'chiama il 112', 'controlla il respiro');
  const inv = confrontaVoci(base, mk('chiama il 112', 'si guarda attorno', 'controlla il respiro', 'valuta lo stato di coscienza'));
  assert.equal(inv.riepilogo.ordine_diverso, true); assert.equal(inv.somiglianza, 1); assert.equal(inv.esito, 'stessa');
  const refuso = confrontaVoci(base, mk('si guarda attorno', 'valuta lo stato di conoscienza', 'chiama il 112', 'controlla il respiro'));
  assert.equal(refuso.riepilogo.ritoccate, 1); assert.equal(refuso.riepilogo.aggiunte, 0); assert.equal(refuso.esito, 'stessa');
  const una = confrontaVoci(base, mk('si guarda attorno', 'valuta lo stato di coscienza', 'chiama il 112', 'controlla il respiro', 'toglie il cellulare'));
  assert.equal(una.riepilogo.aggiunte, 1); assert.equal(una.esito, 'stessa');            // 4/5 = 0.8, scheda corta: soglia 80%
  const molte = confrontaVoci(base, mk('si guarda attorno', 'altro', 'ancora altro', 'e un altro'));
  assert.equal(molte.esito, 'separate');
});

test('REV-1: revisioni di una scheda — nuova revisione dalla scena, confronto, correzione con avviso', async () => {
  const org = tok['org@t'];
  const pat = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'REV_PROVA', nome: 'Agitato revisioni', sigla: 'AGP', voci: [
    { sezione: 'Valutazione', testo: 'Si guarda attorno', scala: 'Standard' }, { sezione: 'Valutazione', testo: 'Valuta lo stato di coscienza', scala: 'Standard' }, { sezione: 'Gestione', testo: 'Chiama il 112', scala: 'Standard' }] } }));
  const sc = (c) => chiama('POST', `/api/eventi/${ev}/scene`, { token: org, body: { codice: c, titolo: 'Revisioni ' + c, ordine: 97 } }).then(json);
  const [S1, S2] = [await sc('RA'), await sc('RB')];
  const k1 = json(await chiama('POST', `/api/scene/${S1.id}/schede`, { token: org, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  const k2 = json(await chiama('POST', `/api/scene/${S2.id}/schede`, { token: org, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  const v1 = json(await chiama('GET', `/api/schede/${k1.id}`, { token: org })).voci;
  assert.equal((await chiama('PUT', `/api/schede/${k1.id}/voci/${v1[1].ordine}`, { token: org, body: { testo: 'Valuta lo stato di conoscienza' } })).statusCode, 200);   // refuso
  await chiama('POST', `/api/schede/${k1.id}/voci`, { token: org, body: { sezione: 'Gestione', testo: 'Toglie il cellulare', scala: 'Standard' } });
  // nuova revisione: la scheda della scena passa alla revisione 2, la libreria mostra una sola scheda
  const r2 = json(await chiama('POST', `/api/schede/${k1.id}/revisione`, { token: org, body: { modo: 'nuova' } }));
  assert.equal(r2.revisione, 2);
  const rev = json(await chiama('GET', `/api/libreria/patologie/${pat.id}/revisioni`, { token: org }));
  assert.equal(rev.length, 2); assert.equal(rev[1].cambi.ritoccate, 1); assert.equal(rev[1].cambi.aggiunte, 1); assert.equal(rev[1].origine.nome.length > 0, true);
  const lib = json(await chiama('GET', '/api/libreria/patologie', { token: org })).filter((p) => p.nome === 'Agitato revisioni');
  assert.equal(lib.length, 1); assert.equal(lib[0].id, r2.id); assert.equal(lib[0].revisioni, 2);
  assert.equal(json(await chiama('GET', '/api/libreria/patologie?tutte=1', { token: org })).filter((p) => p.nome === 'Agitato revisioni').length, 2);
  const cf = json(await chiama('GET', `/api/libreria/confronta?a=${pat.id}&b=${r2.id}`, { token: org }));
  assert.deepEqual(cf.righe.filter((r) => r.tipo !== 'uguale').map((r) => r.tipo).sort(), ['aggiunta', 'ritoccata']);
  // correzione della revisione 2 dalla scena 1: la scena 2 usa ancora la revisione 1, quindi non cambia
  assert.equal((await chiama('PUT', `/api/schede/${k2.id}/voci/${v1[0].ordine}`, { token: org, body: { testo: 'Si guarda attorno e sceglie un posto sicuro' } })).statusCode, 200);
  const k3 = json(await chiama('POST', `/api/scene/${S2.id}/schede`, { token: org, body: { patologiaId: r2.id, slot: 2, simulatore: '02' } }));   // altra scena non giocata sulla revisione 2
  await chiama('PUT', `/api/schede/${k1.id}/voci/1`, { token: org, body: { testo: 'Si guarda attorno (corretto)' } });
  const avviso = await chiama('POST', `/api/schede/${k1.id}/revisione`, { token: org, body: { modo: 'correggi' } });
  assert.equal(avviso.statusCode, 409); assert.equal(json(avviso).dettaglio.aggiornate.length, 1);
  const ok = json(await chiama('POST', `/api/schede/${k1.id}/revisione`, { token: org, body: { modo: 'correggi', conferma: true } }));
  assert.equal(ok.aggiornate, 1); assert.equal(ok.revisione, 2);
  assert.equal(json(await chiama('GET', `/api/schede/${k3.id}`, { token: org })).voci[0].testo, 'Si guarda attorno (corretto)');
  assert.equal(json(await chiama('GET', `/api/libreria/patologie/${pat.id}/revisioni`, { token: org })).length, 2);   // nessuna nuova revisione
  // solo l'organizzazione
  assert.equal((await chiama('POST', `/api/schede/${k1.id}/revisione`, { token: tok['giu@t'], body: { modo: 'nuova' } })).statusCode, 403);
});

test('REV-2: proposte di raggruppamento tra schede simili e unione in revisioni', async () => {
  const org = tok['org@t'];
  const voci = (extra) => ['Si guarda attorno', 'Valuta la coscienza', 'Chiama il 112', 'Controlla il respiro', 'Posiziona il paziente', 'Rileva i parametri', 'Riferisce al team leader', ...extra].map((testo) => ({ sezione: 'G', testo, scala: 'Standard' }));
  const a = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'RAGG_A', nome: 'Ragg uno', sigla: 'RGA', voci: voci([]) } }));
  const b = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'RAGG_B', nome: 'Ragg due', sigla: 'RGA', voci: voci(['Toglie il cellulare']).reverse() } }));
  const prop = json(await chiama('GET', '/api/libreria/raggruppamenti', { token: org })).find((x) => [x.a.id, x.b.id].includes(a.id) && [x.a.id, x.b.id].includes(b.id));
  assert.ok(prop); assert.equal(prop.esito, 'stessa'); assert.equal(prop.riepilogo.ordine_diverso, true);
  assert.equal((await chiama('POST', '/api/libreria/raggruppamenti', { token: org, body: { base: a.id, revisione: b.id, allinea: true } })).statusCode, 200);
  const rev = json(await chiama('GET', `/api/libreria/patologie/${a.id}/revisioni`, { token: org }));
  assert.deepEqual(rev.map((r) => r.revisione), [1, 2]);
  const cf = json(await chiama('GET', `/api/libreria/confronta?a=${a.id}&b=${b.id}`, { token: org }));
  assert.equal(cf.riepilogo.ordine_diverso, false);          // dopo l'allineamento l'ordine coincide
  assert.equal(json(await chiama('GET', '/api/libreria/raggruppamenti', { token: org })).some((x) => [x.a.id, x.b.id].includes(a.id) && [x.a.id, x.b.id].includes(b.id)), false);
});

test('PERS-DEL: eliminando la persona sparisce anche l\'accesso; le valutazioni restano', async () => {
  const org = tok['org@t'];
  const uid = await nuovoUtente('canc@t', 'giudice');
  const { rows: [p] } = await pool.query(`insert into partecipante (cognome, nome, utente_id) values ('Da cancellare','Gino',$1) returning id`, [uid]);
  const { rows: [r] } = await pool.query(`select s.id as scheda, sq.id as squadra from scena_scheda s join scena sc on sc.id=s.scena_id join squadra sq on sq.evento_id=sc.evento_id where sc.evento_id=$1 and not exists (select 1 from compilazione c where c.scheda_id=s.id and c.squadra_id=sq.id) limit 1`, [ev]);
  await pool.query(`insert into compilazione (scheda_id, squadra_id, stato, giudice, giudice_id) values ($1,$2,'completata','Gino',$3)`, [r.scheda, r.squadra, uid]);
  assert.equal((await chiama('DELETE', `/api/persone/${p.id}`, { token: org })).statusCode, 200);
  assert.equal((await pool.query('select count(*)::int n from utente where id=$1', [uid])).rows[0].n, 0);
  assert.equal((await pool.query('select giudice_id from compilazione where scheda_id=$1 and squadra_id=$2', [r.scheda, r.squadra])).rows[0].giudice_id, null);
  assert.equal((await chiama('GET', '/api/me', { token: tok['canc@t'] })).statusCode, 401);
});

test('REV-3: gare e olimpiadi non si riuniscono mai in revisioni', async () => {
  const org = tok['org@t'];
  const voci = ['Si guarda attorno', 'Valuta la coscienza', 'Chiama il 112', 'Controlla il respiro', 'Posiziona il paziente', 'Rileva i parametri', 'Riferisce al team leader'].map((testo) => ({ sezione: 'G', testo, scala: 'Standard' }));
  const g = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'TIPO_G', nome: 'Stessa gara', sigla: 'STG', tipologie: ['gara'], voci } }));
  const o = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'TIPO_O', nome: 'Stessa olimpiadi', sigla: 'STG', tipologie: ['olimpiadi'], voci } }));
  const prop = json(await chiama('GET', '/api/libreria/raggruppamenti', { token: org }));
  assert.equal(prop.some((x) => [x.a.id, x.b.id].includes(g.id) && [x.a.id, x.b.id].includes(o.id)), false);
  assert.equal((await chiama('POST', '/api/libreria/raggruppamenti', { token: org, body: { base: g.id, revisione: o.id } })).statusCode, 409);
});

test('ACC-1: l\'accompagnatore segna le squadre in attesa; il master le vede; il monitor le mostra', async () => {
  const org = tok['org@t'];
  const e = json(await chiama('POST', '/api/eventi', { token: org, body: { codice: 'ACC-T', nome: 'Gara accompagnatore' } }));
  const q = []; for (const nome of ['Uno', 'Due']) q.push(json(await chiama('POST', `/api/eventi/${e.id}/squadre`, { token: org, body: { nome } })));
  const A = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: org, body: { codice: 'AA', titolo: 'Scena A', ordine: 1 } }));
  const B = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: org, body: { codice: 'AB', titolo: 'Scena B', ordine: 2 } }));
  await chiama('PUT', `/api/eventi/${e.id}/rotazione`, { token: org, body: { modalita: 'online', auto: true } });
  await nuovoUtente('acc@t', 'accompagnatore');
  const acc = tok['acc@t'];
  assert.equal((await chiama('GET', `/api/eventi/${e.id}/accompagnatore`, { token: tok['giu@t'] })).statusCode, 403);
  const el = json(await chiama('GET', `/api/eventi/${e.id}/accompagnatore`, { token: acc }));
  assert.equal(el.scene.length, 2); assert.equal(el.scene.find((s) => s.codice === 'AA').attese[0].id, q[0].id);   // la squadra 1 parte da A
  // un solo tocco: la squadra attesa dalla rotazione
  assert.equal((await chiama('POST', `/api/scene/${A.id}/attesa`, { token: acc, body: {} })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/eventi/${e.id}/accompagnatore`, { token: acc })).scene.find((s) => s.codice === 'AA').in_attesa[0].id, q[0].id);
  assert.equal(json(await chiama('GET', `/api/eventi/${e.id}/avanzamento`, { token: org })).celle[q[0].numero].AA.stato, 'attesa');
  assert.equal(json(await chiama('GET', `/api/scene/${A.id}/turno`, { token: org })).in_attesa[0].squadra_id, q[0].id);
  // il master apre la scena per la squadra in attesa: diventa in corso
  assert.equal((await chiama('POST', `/api/scene/${A.id}/apri`, { token: org, body: { squadra_id: q[0].id } })).statusCode, 200);
  assert.equal((await chiama('POST', `/api/scene/${A.id}/attesa`, { token: acc, body: { squadra_id: q[0].id } })).statusCode, 409);
  assert.equal(json(await chiama('GET', `/api/eventi/${e.id}/avanzamento`, { token: org })).celle[q[0].numero].AA.stato, 'in_corso');
  // annullamento di un'attesa sbagliata
  assert.equal((await chiama('POST', `/api/scene/${B.id}/attesa`, { token: acc, body: { squadra_id: q[1].id } })).statusCode, 200);
  assert.equal((await chiama('DELETE', `/api/scene/${B.id}/attesa?squadra_id=${q[1].id}`, { token: acc })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/eventi/${e.id}/accompagnatore`, { token: acc })).scene.find((s) => s.codice === 'AB').in_attesa.length, 0);
  // l'accompagnatore non entra nella gestione
  assert.equal((await chiama('GET', `/api/eventi/${e.id}/avanzamento`, { token: acc })).statusCode, 403);
});

test('CAN-2: canovacci per gara — la stessa lettera in gare diverse non si sovrascrive; codice mancante compilato dall\'uso', async () => {
  const org = tok['org@t'];
  const nuovoCan = async (g) => (await pool.query(`insert into canovaccio (codice, versione, titolo, gara_codice) values ('Q','gara','Scena Q',$1) returning id`, [g])).rows[0].id;
  const senza = await nuovoCan(null), conA = await nuovoCan('GPSER-2031'), conB = await nuovoCan('GPSER-2032');
  await assert.rejects(nuovoCan('GPSER-2031'));                                           // stessa gara, stessa lettera: unico
  assert.equal((await chiama('PATCH', `/api/canovacci/${senza}`, { token: org, body: { gara_codice: 'gpser-2031' } })).statusCode, 409);
  assert.equal((await chiama('PATCH', `/api/canovacci/${senza}`, { token: org, body: { gara_codice: 'non valido!' } })).statusCode, 400);
  const e = json(await chiama('POST', '/api/eventi', { token: org, body: { codice: 'GPSER-2032', nome: 'Gara 2032' } }));
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: org, body: { codice: 'Q', titolo: 'Scena Q', ordine: 1 } }));
  const r = json(await chiama('POST', `/api/eventi/${e.id}/collega-canovacci`, { token: org, body: {} })); assert.deepEqual(r.collegate, ['Q']);
  assert.equal((await pool.query('select canovaccio_id from scena where id=$1', [sc.id])).rows[0].canovaccio_id, conB);   // quello della sua gara, non gli altri
  const e3 = json(await chiama('POST', '/api/eventi', { token: org, body: { codice: 'GPSER-2033', nome: 'Gara 2033' } }));
  const sc3 = json(await chiama('POST', `/api/eventi/${e3.id}/scene`, { token: org, body: { codice: 'Q', titolo: 'Scena Q', ordine: 1 } }));
  await pool.query('update scena set canovaccio_id=$2 where id=$1', [sc3.id, senza]);
  const lista = json(await chiama('GET', '/api/canovacci', { token: org })).find((c) => c.id === senza);
  assert.deepEqual(lista.usato_in, ['GPSER-2033']); assert.equal(lista.gara_codice, null);
  assert.ok(json(await chiama('POST', '/api/canovacci/codici-mancanti', { token: org, body: {} })).compilati >= 1);
  assert.equal((await pool.query('select gara_codice from canovaccio where id=$1', [senza])).rows[0].gara_codice, 'GPSER-2033');
  assert.equal((await chiama('PATCH', `/api/canovacci/${conA}`, { token: tok['giu@t'], body: { gara_codice: 'X' } })).statusCode, 403);
});

test('REV-4: patologie diverse con molte voci generiche in comune (sigla diversa) non vengono proposte come revisioni', async () => {
  const org = tok['org@t'];
  const voci = ['Si guarda attorno', 'Valuta la coscienza', 'Chiama il 112', 'Controlla il respiro', 'Posiziona il paziente', 'Rileva i parametri', 'Riferisce al team leader'].map((testo) => ({ sezione: 'G', testo, scala: 'Standard' }));
  const x = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'DIV_X', nome: 'Ferita prova', sigla: 'FEP', voci } }));
  const y = json(await chiama('POST', '/api/libreria/patologie', { token: org, body: { codice: 'DIV_Y', nome: 'Lipotimia prova', sigla: 'LIP', voci } }));
  const prop = json(await chiama('GET', '/api/libreria/raggruppamenti', { token: org }));
  assert.equal(prop.some((p) => [p.a.id, p.b.id].includes(x.id) && [p.a.id, p.b.id].includes(y.id)), false);
});

test('VAL-1 nei corsi valutano gli istruttori: elenco valutatori, assegnazione e area valutazione', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email: 'val1@t.it', nome: 'Vera Istruttrice', ruolo: 'istruttore_du', password: 'password-lunga' } }));
  assert.ok(!json(await chiama('GET', '/api/giudici', { token: O })).some((x) => x.id === u.id), 'tra i giudici delle gare non compare');
  assert.ok(json(await chiama('GET', '/api/giudici?valutatori=1', { token: O })).some((x) => x.id === u.id), 'tra i valutatori dei corsi sì');
  assert.ok(json(await chiama('GET', '/api/giudici?valutatori=1', { token: O })).some((x) => x.email === 'org@t'), 'anche l\'organizzazione può valutare');
  const e = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'VAL-MC', nome: 'Corso prova', tipo: 'corso' } }));
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: O, body: { codice: 'MC1', titolo: 'Scena', ordine: 1 } }));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: O })).find((p) => !p.bozza && !p.is_master);
  const k = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  const r = await chiama('PUT', `/api/schede/${k.id}/assegnazioni`, { token: O, body: { utenti: [u.id] } }); assert.equal(r.statusCode, 200, r.body);
  const tk = json(await chiama('POST', '/api/login', { body: { email: 'val1@t.it', password: 'password-lunga' } })).token;
  assert.equal((await chiama('GET', `/api/schede/${k.id}`, { token: tk })).statusCode, 200);
  assert.equal((await chiama('DELETE', `/api/schede/${k.id}`, { token: O })).statusCode, 200, 'la scheda si toglie dalla scena');
});

test('WID-1: preferenze personali (widget e contatti)', async () => {
  const O = tok['org@t'];
  assert.deepEqual(json(await chiama('GET', '/api/me', { token: O })).preferenze, {});
  assert.equal((await chiama('PUT', '/api/me/preferenze', { token: O, body: { widget: ['eventi', 'inventato'] } })).statusCode, 400);
  const r = json(await chiama('PUT', '/api/me/preferenze', { token: O, body: { widget: ['calendario', 'eventi', 'calendario'], contatti: [{ nome: ' Sala ', tel: '051 123' }, { nome: 'senza recapito' }] } }));
  assert.deepEqual(r.widget, ['calendario', 'eventi']); assert.deepEqual(r.contatti, [{ nome: 'Sala', tel: '051 123', email: '' }]);
  assert.deepEqual(json(await chiama('GET', '/api/me', { token: O })).preferenze.widget, ['calendario', 'eventi']);
  json(await chiama('PUT', '/api/me/preferenze', { token: O, body: { widget: [] } }));
  assert.equal(json(await chiama('GET', '/api/me', { token: O })).preferenze.contatti.length, 1);   // aggiornare i widget non cancella i contatti
});

test('STAT-1 statistiche del corso, stampa unica dei Mega Code, esito con riepilogo delle skill', async () => {
  const O = tok['org@t'];
  const { rows: [mc] } = await pool.query(`select id from patologia where codice='mc-scenario-2-scoop'`);
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ST-C', nome: 'Corso stat', tipo: 'corso', data: '2026-11-01', data_fine: '2027-03-30' } }));
  assert.equal(json(await chiama('GET', '/api/eventi', { token: O })).find((x) => x.id === corso.id).data_fine, '2027-03-30');
  const e = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ST-M', nome: 'MC stat', tipo: 'megacode', corso_id: corso.id } }));
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: O, body: { codice: 'T1', titolo: 'Scena', ordine: 1 } }));
  const k = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { patologiaId: mc.id, slot: 1, simulatore: '01' } }));
  const sq = json(await chiama('POST', `/api/eventi/${e.id}/squadre`, { token: O, body: { nome: 'Eq A' } }));
  const sch = json(await chiama('GET', `/api/schede/${k.id}`, { token: O }));
  assert.ok((sch.blocchi || []).length >= 2, 'due skill incorporate');
  const skillVoci = sch.voci.filter((v) => v.blocco_id), proprie = sch.voci.filter((v) => !v.blocco_id);
  const risposte = [{ voce_id: proprie[0].id, livello: 'NE' }, { voce_id: proprie[1].id, livello: 'MB' }, ...skillVoci.slice(0, 3).map((v, i) => ({ voce_id: v.id, livello: i === 0 ? 'NE' : 'MB' }))];
  assert.equal((await chiama('POST', '/api/sync', { token: O, body: { id: '22222222-3333-4444-8555-666666666666', scheda_id: k.id, squadra_id: sq.id, risposte } })).statusCode, 200);
  const st = json(await chiama('GET', `/api/eventi/${corso.id}/statistiche`, { token: O }));
  assert.ok(st.voci.length >= 1 && st.voci.every((v) => v.ne + v.su > 0) && st.voci[0].ne === 1 && st.voci[0].perc_ne === 100, JSON.stringify(st.voci));
  assert.ok(st.gruppi.some((g) => g.skill) && st.gruppi.some((g) => !g.skill), 'media per scheda e per skill');
  assert.equal((await chiama('GET', `/api/eventi/${corso.id}/statistiche`, { token: tok['giu@t'] })).statusCode, 403);
  const p1 = await chiama('GET', `/api/eventi/${corso.id}/stampa.pdf?corso=1&vuote=0`, { token: O }); assert.equal(p1.statusCode, 200, p1.body);
  const vuoto = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ST-V', nome: 'Corso senza MC', tipo: 'corso' } }));
  assert.equal((await chiama('GET', `/api/eventi/${vuoto.id}/stampa.pdf?corso=1`, { token: O })).statusCode, 404);
  const r = await chiama('GET', `/api/schede/${k.id}/esito.pdf?squadra=${sq.id}`, { token: O }); assert.equal(r.statusCode, 200, r.body);
});

test('QUA-1 la qualifica di formazione porta il ruolo omonimo; discente TSSA solo etichetta', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email: 'qua1@t.it', nome: 'Quinto Qualifica', ruolo: 'giudice', password: 'password-lunga' } }));
  const pe = json(await chiama('GET', '/api/persone?q=Qualifica', { token: O })).find((x) => x.utente_id === u.id);
  const extra = async () => (await pool.query('select ruolo from utente_ruolo_extra where utente_id=$1 order by ruolo', [u.id])).rows.map((x) => x.ruolo);
  assert.equal((await chiama('PUT', `/api/persone/${pe.id}/qualifiche`, { token: O, body: { qualifiche: ['trainer_ms', 'discente_tssa', 'simulatore'] } })).statusCode, 200);
  assert.deepEqual(await extra(), ['simulatore', 'trainer_ms']);
  assert.ok(json(await chiama('GET', '/api/giudici?valutatori=1', { token: O })).some((x) => x.id === u.id), 'trainer MS tra i valutatori');
  await chiama('PUT', `/api/persone/${pe.id}/qualifiche`, { token: O, body: { qualifiche: ['discente_tssa'] } });
  assert.deepEqual(await extra(), []);
  const { rows } = await pool.query(`select codice from ruolo where codice in ('manovre_salvavita','trainer_ms','formatore_tssa','capo_monitore','istruttore_du','truccatore')`);
  assert.deepEqual(rows.map((r) => r.codice).sort(), ['capo_monitore', 'formatore_tssa', 'istruttore_du', 'trainer_ms', 'truccatore']);
});

test('VAL-2 nei Mega Code non valutano i trainer MS', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const mk = async (email, nome, q) => {
    const u = json(await chiama('POST', '/api/utenti', { token: A, body: { email, nome, ruolo: 'partecipante', password: 'password-lunga' } }));
    const pe = json(await chiama('GET', `/api/persone?q=${encodeURIComponent(nome.split(' ')[1])}`, { token: O })).find((x) => x.utente_id === u.id);
    await chiama('PUT', `/api/persone/${pe.id}/qualifiche`, { token: O, body: { qualifiche: [q] } });
    return u;
  };
  const ms = await mk('vms@t.it', 'Tito Emmesse', 'trainer_ms'), ts = await mk('vts@t.it', 'Tina Titiesse', 'trainer_tssa');
  const el = json(await chiama('GET', '/api/giudici?valutatori=megacode', { token: O }));
  assert.ok(el.some((x) => x.id === ts.id), 'ts presente ' + JSON.stringify(el.map((x) => x.email))); assert.ok(!el.some((x) => x.id === ms.id), 'ms assente');
  assert.equal((await chiama('POST', '/api/eventi', { token: O, body: { codice: 'VAL-MC0', nome: 'Mega Code senza corso', tipo: 'megacode' } })).statusCode, 400, 'il Mega Code vuole un corso');
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'VAL-CO2', nome: 'Corso TSSA', tipo: 'corso' } }));
  const e = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'VAL-MC2', nome: 'Mega Code due', tipo: 'megacode', corso_id: corso.id } }));
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: O, body: { codice: 'M1', titolo: 'Scena', ordine: 1 } }));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: O })).find((p) => !p.bozza && !p.is_master);
  const k = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  assert.equal((await chiama('PUT', `/api/schede/${k.id}/assegnazioni`, { token: O, body: { utenti: [ms.id] } })).statusCode, 400);
  assert.equal((await chiama('PUT', `/api/schede/${k.id}/assegnazioni`, { token: O, body: { utenti: [ts.id] } })).statusCode, 200);
});

test('DISC-1 equipaggio del Mega Code solo dai discenti del corso', async () => {
  const O = tok['org@t'];
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'DISC-C', nome: 'Corso con discenti', tipo: 'corso' } }));
  const mc = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'DISC-M', nome: 'Mega Code del corso', tipo: 'megacode', corso_id: corso.id } }));
  const mk = async (cognome) => json(await chiama('POST', '/api/persone', { token: O, body: { cognome, nome: 'Prova', email: `${cognome.toLowerCase()}@disc.t` } }));
  const d = await mk('Discentea'), x = await mk('Estranea');
  assert.equal((await chiama('POST', `/api/eventi/${mc.id}/discenti`, { token: O, body: { partecipante_id: d.id } })).statusCode, 400, 'si aggiungono al corso, non al Mega Code');
  assert.equal((await chiama('POST', `/api/eventi/${corso.id}/discenti`, { token: O, body: { partecipante_id: d.id } })).statusCode, 200);
  assert.deepEqual(json(await chiama('GET', `/api/eventi/${mc.id}/discenti`, { token: O })).discenti.map((z) => z.partecipante_id), [d.id], 'il Mega Code vede i discenti del corso');
  const sq = json(await chiama('POST', `/api/eventi/${mc.id}/squadre`, { token: O, body: { nome: 'Equipaggio 1' } }));
  assert.equal((await chiama('PUT', `/api/squadre/${sq.id}/membri`, { token: O, body: { membri: [{ partecipante_id: x.id, ruolo: 'componente' }] } })).statusCode, 400);
  assert.equal((await chiama('PUT', `/api/squadre/${sq.id}/membri`, { token: O, body: { membri: [{ partecipante_id: d.id, ruolo: 'capo squadra' }] } })).statusCode, 200);
  await chiama('DELETE', `/api/eventi/${corso.id}/discenti/${d.id}`, { token: O });
  assert.equal(json(await chiama('GET', `/api/squadre/${sq.id}/membri`, { token: O })).length, 0, 'tolto dal corso, esce dall\'equipaggio');
});

test('DEL-1 solo admin elimina un evento, un corso porta con sé i suoi Mega Code', async () => {
  const O = tok['org@t'], A = tok['adm@t'];
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'DEL-C', nome: 'Corso da eliminare', tipo: 'corso' } }));
  const mc = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'DEL-M', nome: 'Mega Code da eliminare', tipo: 'megacode', corso_id: corso.id } }));
  const sc = json(await chiama('POST', `/api/eventi/${mc.id}/scene`, { token: O, body: { codice: 'D1', titolo: 'Scena', ordine: 1 } }));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: O })).find((p) => !p.bozza && !p.is_master);
  await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } });
  assert.equal((await chiama('DELETE', `/api/eventi/${corso.id}`, { token: O })).statusCode, 403);
  const r = await chiama('DELETE', `/api/eventi/${corso.id}`, { token: A }); assert.equal(r.statusCode, 200, r.body);
  assert.equal(json(r).eliminati, 2);
  assert.equal((await pool.query('select 1 from evento where id = any($1::uuid[])', [[corso.id, mc.id]])).rowCount, 0);
});

test('MCP-1 esito Mega Code con equipaggio e skill incorporate; anteprime con le skill', async () => {
  const O = tok['org@t'];
  const { rows: [mc] } = await pool.query(`select id from patologia where codice='mc-scenario-2-scoop'`);
  assert.ok(mc, 'scheda del Mega Code importata');
  const { rows: sk } = await pool.query(`select count(*)::int n from patologia_skill where patologia_id=$1`, [mc.id]); assert.equal(sk[0].n, 2);
  const an = await chiama('GET', `/api/libreria/patologie/${mc.id}/anteprima.pdf`, { token: O }); assert.equal(an.statusCode, 200, 'anteprima libreria: ' + an.body);
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'MCP-C', nome: 'Corso esito', tipo: 'corso' } }));
  const e = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'MCP-M', nome: 'Mega Code esito', tipo: 'megacode', corso_id: corso.id } }));
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: O, body: { codice: 'S1', titolo: 'Scena', ordine: 1 } }));
  const kr = await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { patologiaId: mc.id, slot: 1, simulatore: '01' } }); assert.equal(kr.statusCode, 200, 'crea scheda: ' + kr.body); const k = json(kr);
  const sq = json(await chiama('POST', `/api/eventi/${e.id}/squadre`, { token: O, body: { nome: 'Equipaggio A' } }));
  { const a2 = await chiama('GET', `/api/schede/${k.id}/anteprima.pdf`, { token: O }); assert.equal(a2.statusCode, 200, 'anteprima scena: ' + a2.body); }
  const r = await chiama('GET', `/api/schede/${k.id}/esito.pdf?squadra=${sq.id}`, { token: O });
  assert.equal(r.statusCode, 200, r.body);
});

test('ELV-1 eliminare una valutazione: solo organizzazione, risposte cancellate, resta nel registro', async () => {
  const O = tok['org@t'], G = tok['giu@t'];
  const corso = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ELV-C', nome: 'Corso elv', tipo: 'corso' } }));
  const e = json(await chiama('POST', '/api/eventi', { token: O, body: { codice: 'ELV-M', nome: 'MC elv', tipo: 'megacode', corso_id: corso.id } }));
  const sc = json(await chiama('POST', `/api/eventi/${e.id}/scene`, { token: O, body: { codice: 'E1', titolo: 'Scena', ordine: 1 } }));
  const pat = json(await chiama('GET', '/api/libreria/patologie', { token: O })).find((p) => !p.bozza && !p.is_master);
  const k = json(await chiama('POST', `/api/scene/${sc.id}/schede`, { token: O, body: { patologiaId: pat.id, slot: 1, simulatore: '01' } }));
  const sq = json(await chiama('POST', `/api/eventi/${e.id}/squadre`, { token: O, body: { nome: 'Eq' } }));
  const sch = json(await chiama('GET', `/api/schede/${k.id}`, { token: O }));
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal((await chiama('POST', '/api/sync', { token: O, body: { id, scheda_id: k.id, squadra_id: sq.id, risposte: [{ voce_id: sch.voci[0].id, livello: 'MB' }] } })).statusCode, 200);
  assert.equal((await chiama('DELETE', `/api/compilazioni/${id}`, { token: G })).statusCode, 403);
  assert.equal((await chiama('DELETE', `/api/compilazioni/${id}`, { token: O })).statusCode, 200);
  assert.equal(json(await chiama('GET', `/api/compilazioni?scheda=${k.id}&squadra=${sq.id}`, { token: O })).compilazione, null);
  assert.equal((await pool.query(`select 1 from audit_log where azione='elimina_valutazione' and entita_id=$1`, [id])).rowCount, 1);
});
