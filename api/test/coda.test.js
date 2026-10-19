import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creaCoda } from '../../web/coda.js';

const memoria = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const errore = (stato, msg = 'errore') => Object.assign(new Error(msg), { stato });
const meta = { scheda_id: 'S1', squadra_id: 'Q1' };
let n = 0; const nid = () => `uuid-${++n}`;

test('CODA-1 un tocco fatto durante un invio non si perde', async () => {
  const st = memoria(); const inviati = [];
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async (p) => { await pausa(40); inviati.push(...p.risposte.map((r) => r.voce_id)); return [{ scartate: 0 }]; } });
  c.voce('k', meta, 'v1', 'MB');
  const invio = c.svuota();
  await pausa(10); c.voce('k', meta, 'v2', 'BE');           // tocco mentre l'invio è in corso
  await invio;
  assert.deepEqual(Object.keys(c.pendenti('k')), ['v2']);    // v2 è ancora in coda, non cancellata
  await c.svuota();
  assert.deepEqual(inviati, ['v1', 'v2']); assert.equal(c.conta().inCoda, 0);
});

test('CODA-2 un tocco sulla stessa voce durante l\'invio vince su quello in volo', async () => {
  const st = memoria(); let ultimo;
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async (p) => { await pausa(30); ultimo = p.risposte[0].livello; return [{}]; } });
  c.voce('k', meta, 'v1', 'MB', '2026-01-01T10:00:00.000Z');
  const invio = c.svuota(); await pausa(5);
  c.voce('k', meta, 'v1', 'NE', '2026-01-01T10:00:01.000Z'); await invio;
  assert.equal(ultimo, 'MB'); assert.equal(c.pendenti('k').v1.livello, 'NE');
  await c.svuota(); assert.equal(ultimo, 'NE');
});

test('CODA-3 "Completa" premuto durante un invio non va perso', async () => {
  const st = memoria(); const payload = [];
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async (p) => { await pausa(30); payload.push(p); return [{}]; } });
  c.voce('k', meta, 'v1', 'MB');
  const a = c.svuota(); await pausa(5);
  c.stato('k', meta, 'completata'); const b = c.svuota();    // seconda richiesta mentre la prima è in corso
  await Promise.all([a, b]);
  assert.ok(payload.some((p) => p.stato === 'completata'));
  assert.equal(c.conta().inCoda, 0);
});

test('CODA-4 senza rete i dati restano; al ritorno della rete partono; la coda è per utente', async () => {
  const st = memoria(); let online = false; const arrivati = [];
  const mk = (utente) => creaCoda({ storage: st, chiave: `coda_${utente}`, nuovoId: nid, invia: async (p) => { if (!online) throw new Error('Failed to fetch'); arrivati.push([utente, p.risposte.length]); return [{}]; } });
  const u1 = mk('giudice1'), u2 = mk('giudice2');
  u1.voce('k', meta, 'v1', 'MB'); u1.voce('k', meta, 'v2', 'BE');
  const r = await u1.svuota();
  assert.equal(r.ok, false); assert.equal(u1.conta().inCoda, 2);
  await u2.svuota();                                          // un altro account non vede né invia i dati del primo
  assert.equal(u2.conta().inCoda, 0);
  online = true; await u1.svuota();
  assert.deepEqual(arrivati, [['giudice1', 2]]); assert.equal(u1.conta().inCoda, 0);
});

test('CODA-5 errore definitivo (4xx): i dati vanno tra le rifiutate, non spariscono, e si possono ripristinare', async () => {
  const st = memoria(); let accetta = false;
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async () => { if (!accetta) throw errore(409, 'squadra disattivata'); return [{}]; } });
  c.voce('k', meta, 'v1', 'MB'); c.voce('k', meta, 'v2', 'NE'); c.stato('k', meta, 'completata');
  const r = await c.svuota();
  assert.equal(r.rifiutate, 1); assert.equal(c.conta().inCoda, 0); assert.equal(c.elencoRifiutate().length, 1);
  assert.match(c.elencoRifiutate()[0].errore, /disattivata/);
  accetta = true; c.riprovaRifiutate();
  assert.equal(c.conta().inCoda, 3);                          // 2 voci + stato
  const r2 = await c.svuota(); assert.equal(r2.ok, true); assert.equal(c.conta().inCoda, 0);
});

test('CODA-6 id in conflitto: nuovo UUID e rinvio con gli stessi dati', async () => {
  const st = memoria(); const visti = [];
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async (p) => { visti.push(p.id); if (visti.length === 1) throw errore(409, "id compilazione già usato per un'altra scheda"); return [{}]; } });
  c.voce('k', meta, 'v1', 'MB');
  const r = await c.svuota();
  assert.equal(r.ok, true); assert.equal(visti.length, 2); assert.notEqual(visti[0], visti[1]); assert.equal(c.conta().inCoda, 0);
});

test('CODA-7 un 500 su una scheda non blocca le altre; lo stato "completata" da solo viene inviato', async () => {
  const st = memoria(); const inviate = [];
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async (p) => { if (p.scheda_id === 'ROTTA') throw errore(500, 'errore interno'); inviate.push(p); return [{}]; } });
  c.voce('a', { scheda_id: 'ROTTA', squadra_id: 'Q' }, 'v1', 'MB');
  c.stato('b', { scheda_id: 'OK', squadra_id: 'Q' }, 'completata');                       // solo stato, nessuna voce
  const r = await c.svuota();
  assert.equal(inviate.length, 1); assert.equal(inviate[0].stato, 'completata');
  assert.equal(r.ok, false); assert.equal(c.conta().inCoda, 1);                          // resta solo la scheda col 500
});

test('CODA-8 401: nulla viene cancellato', async () => {
  const st = memoria();
  const c = creaCoda({ storage: st, nuovoId: nid, invia: async () => { throw errore(401, 'sessione scaduta'); } });
  c.voce('k', meta, 'v1', 'MB');
  const r = await c.svuota(); assert.equal(r.ok, false); assert.equal(c.conta().inCoda, 1); assert.equal(c.conta().rifiutate, 0);
});
