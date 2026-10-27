import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildApp } from '../src/app.js';
import { firmaToken, leggiToken, verificaPassword } from '../src/auth.js';
import { cifra, nuovoSegreto, hashRecupero } from '../src/mfa.js';
import { sincronizza, riapri } from '../src/services/compilazioni.js';
import { verificaAccessoEvento } from '../src/enti.js';
import { accessoSessione } from '../src/esami-accesso.js';
import { areeRichieste } from '../src/permessi.js';

process.env.JWT_SECRET = 'security-test-only-'.repeat(4);
const uid = '11111111-1111-4111-8111-111111111111';
const user = { id: uid, nome: 'Test', email: 'test@example.invalid', admin: true, ruolo: 'organizzazione', aree: [], mfa_attiva: true, mfa_secret: cifra(nuovoSegreto()), mfa_recupero: [], ev_ruoli: [], ev_org: [] };
const headers = (token) => ({ authorization: `Bearer ${token}` });
const evA = '22222222-2222-4222-8222-222222222222', evB = '33333333-3333-4333-8333-333333333333';

test('sync e riapertura rifiutano eventi altrui prima di scrivere', async () => {
  const u = { id: uid, ruolo: 'organizzazione', per_evento: true, eventi_org: [evA] };
  const db = { query: async (sql) => {
    assert.ok(sql.trim().startsWith('select'));
    return { rows: [{ ev_scheda: evB, ev_squadra: evB, attiva: true, evento_id: evB }] };
  } };
  await assert.rejects(sincronizza(db, u, { id: uid, scheda_id: evA, squadra_id: evB }), { statusCode: 403 });
  await assert.rejects(riapri(db, u, uid), { statusCode: 403 });
  await verificaAccessoEvento(db, u, evA);
  await verificaAccessoEvento(db, { ruolo: 'admin' }, evB);
});

test('import e lettura compilazioni rispettano il vincolo per evento', async () => {
  const u = { ...user, admin: false, aree: ['importa', 'valutazione'], per_evento: true, ev_org: [evA] };
  const app = buildApp({ query: async (sql) => ({ rows: sql.includes('from utente u') ? [u] : [{ evento_id: evB }] }) });
  try {
    const auth = headers(firmaToken({ id: uid, via: 'pwd' }));
    const r = await app.inject({ url: `/api/compilazioni?scheda=${uid}&squadra=${evB}`, headers: auth });
    assert.equal(r.statusCode, 403);
    for (const payload of [{ evento_id: evB }, {}]) assert.equal((await app.inject({ method: 'POST', url: '/api/import/excel', headers: auth, payload })).statusCode, 403);
  } finally { await app.close(); }
});

test('le operazioni sensibili hanno un permesso di area esplicito', () => {
  assert.deepEqual(areeRichieste('PUT', '/api/persone/:id/qualifiche'), ['anagrafiche']);
  assert.deepEqual(areeRichieste('POST', '/api/compilazioni/:id/riapri'), ['valutazione']);
});

test('esami locali: creatore, invito, revoca, admin e isolamento eventi', async () => {
  let invited = false;
  const db = { query: async (sql) => sql.includes('sessione_esame_invito') ? { rowCount: invited ? 1 : 0, rows: [] } : { rows: [] } };
  const s = { id: evB, creato_da: uid, comitato: null };
  const local = { id: uid, ruolo: 'organizzazione' }, external = { id: evA, ruolo: 'organizzazione' };
  assert.equal(await accessoSessione(db, local, s), 'gestione');
  assert.equal(await accessoSessione(db, external, s), null);
  invited = true;
  assert.equal(await accessoSessione(db, external, s), 'valutazione');
  invited = false;
  assert.equal(await accessoSessione(db, external, s), null);
  assert.equal(await accessoSessione(db, { ...external, admin: true }, s), 'gestione');
  assert.equal(await accessoSessione(db, { ...local, per_evento: true, eventi_org: [evA] }, { ...s, evento_id: evB }), null);
});

test('ticket MFA e cookie SSO non autorizzano nessuna API protetta', async () => {
  let queries = 0;
  const app = buildApp({ query: async () => { queries++; return { rows: [user] }; } });
  try {
    for (const payload of [{ id: uid, t: 'mfa' }, { p: 'google', state: 'test' }]) {
      for (const url of ['/api/me', '/api/utenti', '/api/eventi']) {
        const r = await app.inject({ url, headers: headers(firmaToken(payload)) });
        assert.equal(r.statusCode, 401);
        assert.equal(r.headers['cache-control'], 'no-store');
      }
    }
    assert.equal(queries, 0);
    assert.equal((await app.inject({ url: '/api/me', headers: headers(firmaToken({ id: uid, via: 'pwd' })) })).statusCode, 200);
  } finally { await app.close(); }
});

test('parser token rifiuta input malformati senza eccezioni', () => {
  for (const v of [null, {}, [], 123, '', 'x.y.z', 'x.é', 'x'.repeat(9000)]) assert.equal(leggiToken(v), null);
  const body = Buffer.from('{invalid').toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64url');
  assert.equal(leggiToken(`${body}.${sig}`), null);
  assert.equal(leggiToken(firmaToken({ id: uid }, -1)), null);
  assert.equal(verificaPassword('test', 'scrypt$bad$bad'), false);
  assert.equal(verificaPassword('test', null), false);
});

test('codice recupero consumato atomicamente anche con richieste concorrenti', async () => {
  const code = 'ABCDE-12345', h = hashRecupero(code);
  let available = true;
  const app = buildApp({ query: async (sql) => {
    if (sql.startsWith('update utente set mfa_recupero')) {
      assert.match(sql, /and \$2 = any\(mfa_recupero\)/);
      const rowCount = available ? 1 : 0; available = false; return { rowCount, rows: [] };
    }
    return { rows: [{ ...user, mfa_recupero: [h] }] };
  } });
  try {
    const payload = { ticket: firmaToken({ id: uid, t: 'mfa' }), codice: code };
    const rs = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url: '/api/login/mfa', payload })));
    assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 401]);
  } finally { await app.close(); }
});

test('SSO_RICHIEDE_MFA restituisce una sfida, non una sessione', async () => {
  const keys = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_URL', 'SSO_RICHIEDE_MFA'];
  const old = keys.map((k) => process.env[k]);
  Object.assign(process.env, { GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-only', PUBLIC_URL: 'https://example.invalid', SSO_RICHIEDE_MFA: '1' });
  let nonce;
  const app = buildApp({ query: async () => ({ rows: [user] }) }, { fetchImpl: async () => ({ ok: true, json: async () => ({ id_token: `test.${Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'test-client', exp: Date.now() / 1000 + 60, nonce, sub: 'test-sub', email: user.email, email_verified: true })).toString('base64url')}.test` }) }) });
  try {
    const altro = await app.inject({ url: '/api/auth/google/inizio' });   // da un indirizzo diverso da PUBLIC_URL: si riparte da quello giusto, senza cookie
    assert.equal(altro.headers.location, 'https://example.invalid/api/auth/google/inizio'); assert.equal(altro.headers['set-cookie'], undefined);
    const start = await app.inject({ url: '/api/auth/google/inizio', headers: { host: 'example.invalid', 'x-forwarded-proto': 'https' } });
    const q = new URL(start.headers.location).searchParams; nonce = q.get('nonce');
    const cb = await app.inject({ url: `/api/auth/google/callback?code=test&state=${q.get('state')}`, headers: { cookie: start.headers['set-cookie'].split(';')[0] } });
    const ticket = cb.headers.location.split('#sso=')[1];
    const r = await app.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().mfa, true);
    assert.equal(r.json().token, undefined);
    assert.equal(leggiToken(r.json().ticket).t, 'mfa');
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/ticket', payload: { ticket } })).statusCode, 401);
  } finally {
    await app.close();
    keys.forEach((k, i) => { if (old[i] === undefined) delete process.env[k]; else process.env[k] = old[i]; });
  }
});
