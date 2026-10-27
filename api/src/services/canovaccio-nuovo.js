// Creazione e modifica di un canovaccio da modulo (senza file .docx): Gara, Olimpiadi o descrizione di uno scenario di Mega Code.
import { httpErr } from './compilazioni.js';

export const VERSIONI = ['gara', 'olimpiadi', 'megacode'];
const t = (v, max = 4000) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
const righe = (v, n = 30, max = 300) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => t(x, max)).filter(Boolean).slice(0, n);

export function normalizzaDati(versione, d = {}) {
  if (versione === 'megacode') {
    return {
      dispatch: t(d.dispatch), scena: t(d.scena), racconto: t(d.racconto), quick_look: righe(d.quick_look),
      abcde: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((k) => [k, t(d.abcde?.[k], 1500)])),
      sample: Object.fromEntries(['S', 'A', 'M', 'P', 'L', 'E'].map((k) => [k, t(d.sample?.[k], 800)])),
      opqrst: t(d.opqrst, 1500), evoluzione: t(d.evoluzione), destinazione: t(d.destinazione, 500),
      trucchi: righe(d.trucchi), comportamenti: righe(d.comportamenti), presidi: righe(d.presidi), note: t(d.note),
    };
  }
  // gara / olimpiadi: testi delle sezioni; pazienti e triage restano quelli del file importato (o vuoti)
  const blocchi = (v) => righe(v, 40, 1500).map((x) => ({ tipo: 'testo', testo: x }));
  const sezioni = [['briefing', 'Briefing per la squadra', d.briefing], ['descrizione', 'Descrizione della scena', d.descrizione], ['scena_recitata', 'Scena recitata', d.scena_recitata]]
    .filter(([, , v]) => righe(v).length).map(([tipo, titolo, v]) => ({ tipo, titolo, blocchi: blocchi(v) }));
  return { sottotitolo: t(d.sottotitolo, 200), squadra: t(d.squadra, 200), sezioni, pazienti: d.pazienti ?? [], triage: d.triage ?? [], logistica: righe(d.logistica, 20, 300).map((x) => { const [k, ...v] = x.split(':'); return { k: k.trim(), v: v.join(':').trim() || '—' }; }) };
}

export function validaIntestazione(b, versione) {
  if (!VERSIONI.includes(versione)) throw httpErr(400, 'tipo di canovaccio: gara, olimpiadi o megacode');
  const codice = t(b.codice, 3).toUpperCase();
  if (!/^[A-Z0-9]{1,3}$/.test(codice)) throw httpErr(400, 'codice scena: 1-3 caratteri maiuscoli o cifre');
  const titolo = t(b.titolo, 150); if (!titolo) throw httpErr(400, 'il titolo è obbligatorio');
  const gara = t(b.gara_codice, 40).toUpperCase() || null;
  if (gara && !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(gara)) throw httpErr(400, 'codice gara: lettere, numeri e trattini (es. GPSER-2027, MC-2026)');
  const tempo = b.tempo_min === '' || b.tempo_min == null ? null : Number(b.tempo_min);
  if (tempo !== null && !(Number.isInteger(tempo) && tempo > 0 && tempo <= 600)) throw httpErr(400, 'tempo in minuti non valido');
  return { codice, titolo, gara, tempo };
}
