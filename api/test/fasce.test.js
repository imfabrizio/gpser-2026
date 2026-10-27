import test from 'node:test';
import assert from 'node:assert/strict';
import { fasceAuto, valutaEsito } from '../src/esito.js';

const da = (n) => Object.fromEntries(fasceAuto(n).map((f) => [f.nome, f.da]));

test('FASCE-1: skill da 10 voci (Casco): 15-16, 17-18, 19, 20', () => {
  assert.deepEqual(da(10), { Insufficiente: 0, Sufficiente: 15, Discreto: 17, Buono: 19, Ottimo: 20 });
});
test('FASCE-2: la sufficienza è sempre il 75% arrotondato per eccesso; ogni fascia sotto l\'Ottimo ha almeno 2 punteggi', () => {
  for (let n = 10; n <= 40; n++) {
    const f = da(n), max = 2 * n;
    assert.equal(f.Sufficiente, Math.ceil(max * 0.75), `n=${n}`);
    assert.ok(f.Discreto - f.Sufficiente >= 2 && f.Buono - f.Discreto >= 2 && f.Ottimo > f.Buono && f.Ottimo <= max, `n=${n}`);
    assert.ok(f.Ottimo >= Math.ceil(max * 0.95), `n=${n}`);
  }
});
test('FASCE-3: valutaEsito senza fasce proprie con fasceAuto', () => {
  const e = valutaEsito({ punti: 16, massimo: 20, fasce: fasceAuto(10) });
  assert.equal(e.giudizio, 'Sufficiente'); assert.equal(e.superato, true);
  assert.equal(valutaEsito({ punti: 14, massimo: 20, fasce: fasceAuto(10) }).superato, false);
});
