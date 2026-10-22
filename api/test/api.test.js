import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { creaPool, inTransazione } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
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
  const rep = await inTransazione(pool, (db) => importaExcel(db, new URL('./fixtures/scena-alfa.xlsx', import.meta.url).pathname,
    { eventoCodice: 'T-1', nomeEvento: 'Test', titoloStampa: 'Gara Test', luogo: 'Piacenza', data: '2026-04-18' }));
  ev = rep.eventoId;
  for (const [email, ruolo, admin] of [['org@t', 'organizzazione', false], ['giu@t', 'giudice', false], ['adm@t', 'organizzazione', true]])
    await pool.query('insert into utente (email, nome, ruolo, admin, password_hash) values ($1,$2,$3,$4,$5)', [email, email, ruolo, admin, hashPassword('pw')]);
  app = buildApp(pool);
  for (const e of ['org@t', 'giu@t', 'adm@t']) tok[e] = json(await chiama('POST', '/api/login', { body: { email: e, password: 'pw' } })).token;
});
after(async () => { await app.close(); await pool.end(); });

test('login: password errata → 401, nessun token → 401', async () => {
  assert.equal((await chiama('POST', '/api/login', { body: { email: 'org@t', password: 'x' } })).statusCode, 401);
  assert.equal((await chiama('GET', '/api/eventi')).statusCode, 401);
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

test('verifica: il giudice non può verificare né modificare una scheda verificata; l\'organizzazione può riaprirla', async () => {
  const base = { id: '11111111-1111-4111-8111-111111111111', scheda_id: scheda, squadra_id: squadra };
  assert.equal((await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, stato: 'verificata' } })).statusCode, 403);
  const ok = await chiama('POST', '/api/sync', { token: tok['org@t'], body: { ...base, stato: 'verificata' } });
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
  const n0 = (await pool.query(`select count(*)::int n from audit_log where azione='modifica_scheda_chiusa'`)).rows[0].n;
  await chiama('POST', '/api/sync', { token: tok['org@t'], body: { id: U(3), scheda_id: master, squadra_id: sq, risposte: [{ voce_id: voce.id, livello: 'MB' }] } });
  assert.equal((await pool.query(`select count(*)::int n from audit_log where azione='modifica_scheda_chiusa'`)).rows[0].n, n0 + 1);
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
  assert.equal((await w('giu@t', 'IN', { stato: 'completata' }))[0].stato, 'completata');
  assert.equal((await chiama('POST', '/api/sync', { token: tok['giu@t'], body: { ...base, stato: 'verificata', risposte: [] } })).statusCode, 403);   // il giudice non chiude
  const corr = await w('mas@t', 'MB');
  assert.equal(corr[0].scritte, 1);
  assert.equal((await w('giu@t', 'NE'))[0].scartate, 1);                              // il giudice non scavalca il master
  const { rows: [a] } = await pool.query(`select dettaglio from audit_log where azione='correzione_master' order by id desc limit 1`);
  assert.equal(a.dettaglio.correzioni[0].prima, 'IN'); assert.equal(a.dettaglio.correzioni[0].dopo, 'MB');
  // il master chiude la scheda
  assert.equal((await w('mas@t', 'MB', { stato: 'verificata' }))[0].stato, 'verificata');
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
  const r = await chiama('GET', '/api/pubblico');
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
  assert.match((await via('microsoft', (n) => mOk(n))).headers.location, /#sso=/);
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
  const base = { nome: 'Mario', cognome: 'Rossi', codice_fiscale: 'RSSMRA85T10A562S', comitato: 'Modena', provincia: 'mo', ruolo_gara: 'giudice' };
  const invia = (b) => a2.inject({ method: 'POST', url: '/api/registrazione', payload: b, headers: H(T) });
  assert.equal((await invia({ ...base, codice_fiscale: 'RSSMRA85T10A562X' })).statusCode, 400);                    // carattere di controllo errato
  assert.equal((await invia({ ...base, comitato: '' })).statusCode, 400);
  assert.equal((await invia({ ...base, ruolo_gara: 'allenatore' })).statusCode, 400);                              // squadra obbligatoria
  assert.equal((await invia({ ...base, ruolo_gara: 'boh' })).statusCode, 400);
  assert.equal((await invia({ ...base, ruolo_gara: 'allenatore', squadra_id: form.squadre[0].id })).statusCode, 200);
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
  assert.equal((await chiama('DELETE', `/api/persone/${(await pool.query('select id from partecipante where utente_id=$1', [ap.id])).rows[0].id}`, { token: A })).statusCode, 409);   // ha un accesso
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
