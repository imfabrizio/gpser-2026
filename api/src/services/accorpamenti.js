// Doppioni in libreria: coppie di schede molto simili da unire (le scene e gli esami che le usano passano a quella scelta).
import { httpErr } from './compilazioni.js';
import { enteUtente, èApprovatore } from '../enti.js';
import { controllaScheda, haSchede } from '../libreria-ambito.js';

const nt = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const SOGLIA = 0.6;

export async function trovaDoppioni(db, utente) {
  const mio = await enteUtente(db, utente);
  // ambito di chi cura il catalogo: admin tutto; l'approvatore la sua regione; la direzione la libreria generale
  const { rows: pat } = await db.query(
    `select p.id, p.nome, p.regione, p.macro, p.tipologie, (select count(*)::int from scena_scheda s where s.patologia_id=p.id) as usi
       from patologia p where not p.bozza and not p.is_master and p.comitato is null
        and ($1::boolean or ($2::text is not null and p.regione = $2::text) or ($3::boolean and p.regione is null))`, [!!utente.admin, mio.regione, haSchede(utente)]);
  if (pat.length < 2) return [];
  const { rows: vv } = await db.query(`select pv.patologia_id as id, v.testo from patologia_voce pv join voce v on v.id=pv.voce_id where pv.patologia_id = any($1::uuid[])`, [pat.map((p) => p.id)]);
  const insiemi = new Map(pat.map((p) => [p.id, new Set()])); for (const r of vv) insiemi.get(r.id).add(nt(r.testo));
  const { rows: ign } = await db.query('select a, b from accorpamento_ignorato');
  const ignorate = new Set(ign.map((x) => `${x.a}|${x.b}`));
  const out = [];
  for (let i = 0; i < pat.length; i++) for (let j = i + 1; j < pat.length; j++) {
    const A = pat[i], B = pat[j]; if ((A.regione ?? null) !== (B.regione ?? null)) continue;
    const [a, b] = A.id < B.id ? [A, B] : [B, A]; if (ignorate.has(`${a.id}|${b.id}`)) continue;
    const sa = insiemi.get(A.id), sb = insiemi.get(B.id); if (!sa.size || !sb.size) continue;
    let inter = 0; for (const x of sa) if (sb.has(x)) inter++;
    const j2 = inter / (sa.size + sb.size - inter);
    if (j2 >= SOGLIA) out.push({ a: { id: a.id, nome: a.nome, usi: a.usi, voci: insiemi.get(a.id).size }, b: { id: b.id, nome: b.nome, usi: b.usi, voci: insiemi.get(b.id).size }, somiglianza: Math.round(j2 * 100) / 100, regione: A.regione ?? null, tipologie: [...new Set([...(A.tipologie || []), ...(B.tipologie || [])])] });
  }
  return out.sort((x, y) => y.somiglianza - x.somiglianza).slice(0, 200);
}

export async function ignora(db, utente, x, y) {
  if (!x || !y || x === y) throw httpErr(400, 'indica due schede diverse');
  const [a, b] = x < y ? [x, y] : [y, x];
  await controllaScheda(db, utente, a, { modifica: true }); await controllaScheda(db, utente, b, { modifica: true });
  await db.query('insert into accorpamento_ignorato (a, b, deciso_da) values ($1,$2,$3) on conflict do nothing', [a, b, utente.id]);
  return { ok: true };
}

// unisce «dup» in «tieni»: i riferimenti passano a «tieni», poi «dup» viene eliminata
export async function unisci(db, utente, dupId, tieniId) {
  if (!tieniId || dupId === tieniId) throw httpErr(400, 'scegli la scheda in cui unire');
  const A = await controllaScheda(db, utente, dupId, { modifica: true }); const B = await controllaScheda(db, utente, tieniId, { modifica: true });
  if ((A.regione ?? null) !== (B.regione ?? null) || A.comitato || B.comitato) throw httpErr(400, 'si possono unire solo schede dello stesso catalogo');
  const { rows: fk } = await db.query(
    `select c.conrelid::regclass::text as tabella, a.attname as colonna from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
      where c.contype='f' and c.confrelid='patologia'::regclass and c.conrelid::regclass::text not in ('patologia_voce','promozione','accorpamento_ignorato')`);
  const spostati = {};
  for (const f of fk) {
    try { await db.query('savepoint sp_unisci'); const r = await db.query(`update ${f.tabella} set ${f.colonna}=$2 where ${f.colonna}=$1`, [dupId, tieniId]); await db.query('release savepoint sp_unisci'); if (r.rowCount) spostati[f.tabella] = r.rowCount; }
    catch (e) { await db.query('rollback to savepoint sp_unisci'); throw httpErr(409, 'le due schede sono usate insieme nello stesso elemento: toglile da lì prima di unirle'); }
  }
  await db.query(`delete from condivisione where tipo='patologia' and risorsa_id=$1`, [dupId]);
  await db.query('delete from patologia where id=$1', [dupId]);
  return { ok: true, spostati };
}
