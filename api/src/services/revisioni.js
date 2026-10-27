// Revisioni delle schede di libreria: confronto per contenuto (non per posizione), soglie di somiglianza, salvataggio dalla scena.
import { httpErr } from './compilazioni.js';
import { enteUtente } from '../enti.js';
import { controllaScheda, haSchede } from '../libreria-ambito.js';

const nt = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const LIV = ['mb', 'be', 'su', 'in', 'ne'];
export const SOGLIA_STESSA = 0.9, SOGLIA_STESSA_CORTA = 0.8, SOGLIA_CONFERMA = 0.75, VOCI_CORTA = 20, SOGLIA_REFUSO = 0.8;

function distanza(a, b) {                              // Levenshtein
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export const simiglianzaTesto = (a, b) => { const x = nt(a), y = nt(b); const m = Math.max(x.length, y.length); return m ? 1 - distanza(x, y) / m : 1; };

// A, B: [{sezione, testo, mb..ne}] in ordine. Restituisce le righe del confronto e il riepilogo.
export function confrontaVoci(A, B) {
  const usateB = new Set(), coppie = [];                // coppie: [iA, iB, tipo]
  const chiaveB = new Map(); B.forEach((v, j) => { const k = nt(v.testo); (chiaveB.get(k) ?? chiaveB.set(k, []).get(k)).push(j); });
  const restoA = [];
  A.forEach((v, i) => { const lista = chiaveB.get(nt(v.testo)); const j = lista?.find((x) => !usateB.has(x)); if (j !== undefined) { usateB.add(j); coppie.push([i, j, 'uguale']); } else restoA.push(i); });
  const candidati = [];                                  // refusi: testo quasi uguale
  for (const i of restoA) B.forEach((v, j) => { if (!usateB.has(j)) { const s = simiglianzaTesto(A[i].testo, v.testo); if (s >= SOGLIA_REFUSO) candidati.push([s, i, j]); } });
  candidati.sort((x, y) => y[0] - x[0]);
  const presaA = new Set();
  for (const [, i, j] of candidati) if (!presaA.has(i) && !usateB.has(j)) { presaA.add(i); usateB.add(j); coppie.push([i, j, 'ritoccata']); }
  const righe = [];
  for (const [i, j, tipo] of coppie) {
    const a = A[i], b = B[j]; const punti = LIV.some((l) => (a[l] ?? null) !== (b[l] ?? null));
    righe.push({ tipo, a: a.testo, b: b.testo, sezione_a: a.sezione, sezione_b: b.sezione, punti, sezione: nt(a.sezione) !== nt(b.sezione), pa: LIV.map((l) => a[l] ?? null), pb: LIV.map((l) => b[l] ?? null), posA: i, posB: j });
  }
  for (const i of restoA) if (!presaA.has(i)) righe.push({ tipo: 'tolta', a: A[i].testo, sezione_a: A[i].sezione, pa: LIV.map((l) => A[i][l] ?? null), posA: i });
  B.forEach((v, j) => { if (!usateB.has(j)) righe.push({ tipo: 'aggiunta', b: v.testo, sezione_b: v.sezione, pb: LIV.map((l) => v[l] ?? null), posB: j }); });
  righe.sort((x, y) => (x.posB ?? 1e6 + x.posA) - (y.posB ?? 1e6 + y.posA));
  const n = (t) => righe.filter((r) => r.tipo === t).length;
  const accoppiate = coppie.length, tot = A.length + B.length - accoppiate;
  const ordA = coppie.slice().sort((x, y) => x[0] - y[0]).map((c) => c[1]);
  const ordine_diverso = ordA.some((j, k) => k > 0 && j < ordA[k - 1]);
  const somiglianza = tot ? accoppiate / tot : 1;
  const alta = Math.max(A.length, B.length) < VOCI_CORTA ? SOGLIA_STESSA_CORTA : SOGLIA_STESSA;
  const esito = somiglianza >= alta ? 'stessa' : somiglianza >= SOGLIA_CONFERMA ? 'conferma' : 'separate';
  return { righe, riepilogo: { uguali: n('uguale'), ritoccate: n('ritoccata'), aggiunte: n('aggiunta'), tolte: n('tolta'), punti: righe.filter((r) => r.punti).length, ordine_diverso }, somiglianza: Math.round(somiglianza * 100) / 100, esito, soglia: alta };
}

export async function vociPatologia(db, id) {
  return (await db.query(`select pv.ordine, pv.sezione, v.testo, pv.is_sep, sp.mb, sp.be, sp.su, sp."in", sp.ne, sp.codice as scala from patologia_voce pv
    join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id where pv.patologia_id=$1 order by pv.ordine`, [id])).rows;
}

export async function confronta(db, utente, a, b) {
  await controllaScheda(db, utente, a, { modifica: false }); await controllaScheda(db, utente, b, { modifica: false });
  const { rows: nomi } = await db.query('select id, nome, revisione from patologia where id = any($1::uuid[])', [[a, b]]);
  return { a: nomi.find((x) => x.id === a), b: nomi.find((x) => x.id === b), ...confrontaVoci(await vociPatologia(db, a), await vociPatologia(db, b)) };
}

export async function revisioni(db, utente, id) {
  await controllaScheda(db, utente, id, { modifica: false });
  const { rows: gr } = await db.query(
    `select p.id, p.nome, p.revisione, p.creata_il, p.bozza, (select nome from utente where id=p.creata_da) as autore,
            (select jsonb_build_object('nome', e.nome, 'luogo', e.luogo, 'data', to_char(e.data,'YYYY-MM-DD')) from evento e where e.id=p.evento_origine_id) as origine,
            (select coalesce(jsonb_agg(jsonb_build_object('evento', x.nome, 'luogo', x.luogo, 'data', to_char(x.data,'YYYY-MM-DD')) order by x.data desc nulls last), '[]'::jsonb)
               from (select distinct e.id, e.nome, e.luogo, e.data from scena_scheda ss join scena s on s.id=ss.scena_id join evento e on e.id=s.evento_id where ss.patologia_id=p.id) x) as usi
       from patologia p where p.gruppo_id = (select gruppo_id from patologia where id=$1) order by p.revisione`, [id]);
  const prima = gr[0] ? await vociPatologia(db, gr[0].id) : [];
  for (const r of gr) { const c = r === gr[0] ? null : confrontaVoci(prima, await vociPatologia(db, r.id)); r.cambi = c ? c.riepilogo : null; r.voci = (await vociPatologia(db, r.id)).length; }
  return gr;
}

// proposte di raggruppamento tra schede del catalogo: per contenuto, senza dipendere dall'ordine
export async function proposteRaggruppamento(db, utente) {
  const mio = await enteUtente(db, utente);
  const { rows: pat } = await db.query(
    `select p.id, p.gruppo_id, p.nome, p.sigla, p.regione, p.revisione, array_to_string(array(select unnest(p.tipologie) order by 1), ',') as tip, (select count(*)::int from scena_scheda s where s.patologia_id=p.id) as usi
       from patologia p where not p.bozza and not p.is_master and p.comitato is null
        and p.revisione = (select max(revisione) from patologia q where q.gruppo_id=p.gruppo_id)
        and ($1::boolean or ($2::text is not null and p.regione = $2::text) or ($3::boolean and p.regione is null))`, [!!utente.admin, mio.regione, haSchede(utente)]);
  if (pat.length < 2) return [];
  const { rows: vv } = await db.query(`select pv.patologia_id as id, pv.ordine, pv.sezione, v.testo, sp.mb, sp.be, sp.su, sp."in", sp.ne from patologia_voce pv join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id
    where pv.patologia_id = any($1::uuid[]) order by pv.patologia_id, pv.ordine`, [pat.map((p) => p.id)]);
  const voci = new Map(pat.map((p) => [p.id, []])); for (const r of vv) voci.get(r.id).push(r);
  const chiavi = new Map(pat.map((p) => [p.id, new Set(voci.get(p.id).map((v) => nt(v.testo)))]));
  const { rows: ign } = await db.query('select a, b from accorpamento_ignorato'); const ignorate = new Set(ign.map((x) => `${x.a}|${x.b}`));
  const out = [];
  for (let i = 0; i < pat.length; i++) for (let j = i + 1; j < pat.length; j++) {
    const A = pat[i], B = pat[j]; if (A.gruppo_id === B.gruppo_id || (A.regione ?? null) !== (B.regione ?? null) || A.tip !== B.tip || A.sigla !== B.sigla) continue;   // gare e olimpiadi hanno percorsi diversi: mai insieme; patologie diverse (sigla diversa) condividono molte voci generiche ma non sono la stessa scheda
    const [x, y] = A.id < B.id ? [A, B] : [B, A]; if (ignorate.has(`${x.id}|${y.id}`)) continue;
    const sa = chiavi.get(A.id), sb = chiavi.get(B.id); if (!sa.size || !sb.size) continue;
    let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
    if (inter / (sa.size + sb.size - inter) < 0.4) continue;       // scarto veloce prima del confronto con i refusi
    const c = confrontaVoci(voci.get(A.id), voci.get(B.id)); if (c.esito === 'separate') continue;
    out.push({ a: { id: A.id, nome: A.nome, usi: A.usi, voci: voci.get(A.id).length }, b: { id: B.id, nome: B.nome, usi: B.usi, voci: voci.get(B.id).length }, somiglianza: c.somiglianza, esito: c.esito, riepilogo: c.riepilogo, regione: A.regione ?? null, tipologie: A.tip.split(',') });
  }
  return out.sort((p, q) => q.somiglianza - p.somiglianza).slice(0, 200);
}

// b diventa la revisione successiva del gruppo di a (non si cancella niente); con allinea le voci di b seguono l'ordine di a
export async function raggruppa(db, utente, aId, bId, { allinea = false } = {}) {
  if (!aId || !bId || aId === bId) throw httpErr(400, 'indica due schede diverse');
  const A = await controllaScheda(db, utente, aId, { modifica: true }); const B = await controllaScheda(db, utente, bId, { modifica: true });
  if ((A.regione ?? null) !== (B.regione ?? null) || A.comitato || B.comitato) throw httpErr(400, 'si possono raggruppare solo schede dello stesso catalogo');
  const { rows: [pa] } = await db.query(`select gruppo_id, array_to_string(array(select unnest(tipologie) order by 1), ',') as tip from patologia where id=$1`, [aId]);
  const { rows: [pb] } = await db.query(`select gruppo_id, array_to_string(array(select unnest(tipologie) order by 1), ',') as tip from patologia where id=$1`, [bId]);
  if (pa.tip !== pb.tip) throw httpErr(409, 'tipologie diverse (per esempio gara e olimpiadi): restano schede separate');
  if (pa.gruppo_id === pb.gruppo_id) throw httpErr(409, 'sono già nello stesso gruppo');
  const { rows: [{ n }] } = await db.query('select count(*)::int as n from patologia where gruppo_id=$1', [pb.gruppo_id]);
  if (n > 1) throw httpErr(409, 'la seconda scheda ha già delle revisioni: scegli la sua ultima revisione');
  const { rows: [{ r }] } = await db.query('select coalesce(max(revisione),0)+1 as r from patologia where gruppo_id=$1', [pa.gruppo_id]);
  await db.query('update patologia set gruppo_id=$2, revisione=$3 where id=$1', [bId, pa.gruppo_id, r]);
  if (allinea) {
    const base = await vociPatologia(db, aId), mie = await vociPatologia(db, bId);
    const c = confrontaVoci(base, mie);
    if (c.riepilogo.ordine_diverso) {
      const ord = new Map(c.righe.filter((x) => x.posB !== undefined && x.posA !== undefined).map((x) => [x.posB, x.posA]));
      const chiave = (k) => (ord.has(k) ? ord.get(k) : 1e6 + k);
      const nuovo = mie.map((_, k) => k).sort((x, y) => chiave(x) - chiave(y));
      await db.query('update patologia_voce set ordine = ordine + 100000 where patologia_id=$1', [bId]);
      for (const [pos, k] of nuovo.entries()) await db.query('update patologia_voce set ordine=$3 where patologia_id=$1 and ordine=$2', [bId, mie[k].ordine + 100000, pos + 1]);
    }
  }
  return { ok: true, revisione: r };
}

async function trovaOCreaScala(db, v) {
  const liv = LIV.map((l) => v[l] ?? null);
  const { rows: [e] } = await db.query(`select id from scala_punteggio where mb is not distinct from $1 and be is not distinct from $2 and su is not distinct from $3 and "in" is not distinct from $4 and ne is not distinct from $5 order by codice limit 1`, liv);
  if (e) return e.id;
  const codice = 'P:' + liv.map((x) => x ?? '-').join('/');
  const { rows: [n] } = await db.query(`insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6) on conflict (codice) do update set codice=excluded.codice returning id`, [codice, ...liv]);
  return n.id;
}
async function trovaOCreaVoce(db, testo) {
  const { rows: [e] } = await db.query('select id from voce where lower(testo)=lower($1)', [testo]); if (e) return e.id;
  return (await db.query('insert into voce (testo) values ($1) returning id', [testo])).rows[0].id;
}
async function copiaVociInPatologia(db, schedaId, patId) {
  const { rows } = await db.query('select * from scena_scheda_voce where scheda_id=$1 order by ordine', [schedaId]);
  await db.query('delete from patologia_voce where patologia_id=$1', [patId]);
  for (const [k, v] of rows.entries()) await db.query('insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,$6)',
    [patId, k + 1, v.sezione, await trovaOCreaVoce(db, v.testo), await trovaOCreaScala(db, v), v.is_sep]);
  return rows.length;
}

// dalla scena: «nuova» crea la revisione successiva; «correggi» sovrascrive la revisione e aggiorna le scene non ancora giocate (con conferma)
export async function salvaRevisioneDaScena(db, utente, schedaId, { modo, conferma = false }) {
  if (!['nuova', 'correggi'].includes(modo)) throw httpErr(400, 'modo: nuova o correggi');
  const { rows: [s] } = await db.query(`select s.id, s.patologia_id, sc.evento_id, e.nome as evento from scena_scheda s join scena sc on sc.id=s.scena_id join evento e on e.id=sc.evento_id where s.id=$1 for update of s`, [schedaId]);
  if (!s) throw httpErr(404, 'scheda inesistente');
  if (!s.patologia_id) throw httpErr(400, 'la scheda non deriva dalla libreria');
  await controllaScheda(db, utente, s.patologia_id, { modifica: true });
  const { rows: [p] } = await db.query('select * from patologia where id=$1', [s.patologia_id]);
  if (modo === 'nuova') {
    const { rows: [{ r }] } = await db.query('select max(revisione)+1 as r from patologia where gruppo_id=$1', [p.gruppo_id]);
    const { rows: [n] } = await db.query(
      `insert into patologia (codice, nome, sigla, is_bls, is_master, is_diu, categoria, categoria2, fasce, descrizione, comitato, creata_da, bozza, macro, macro2, gravita, livello, regione, tipologie, gruppo_id, revisione, evento_origine_id, errori_gravi)
       select $2, nome, sigla, is_bls, is_master, is_diu, categoria, categoria2, fasce, descrizione, comitato, $3, false, macro, macro2, gravita, livello, regione, tipologie, gruppo_id, $4, $5, errori_gravi from patologia where id=$1 returning id`,
      [p.id, `${p.codice}-R${r}-${Math.random().toString(36).slice(2, 6)}`, utente.id, r, s.evento_id]);
    await copiaVociInPatologia(db, schedaId, n.id);
    await db.query('update scena_scheda set patologia_id=$2 where id=$1', [schedaId, n.id]);
    return { ok: true, id: n.id, revisione: r };
  }
  // correggi: le scene non ancora giocate che usano questa revisione prendono le voci corrette
  const { rows: impatto } = await db.query(
    `select ss.id, sc.codice as scena, e.nome as evento, to_char(e.data,'YYYY-MM-DD') as data,
            exists (select 1 from compilazione c where c.scheda_id=ss.id) as giocata
       from scena_scheda ss join scena sc on sc.id=ss.scena_id join evento e on e.id=sc.evento_id where ss.patologia_id=$1 and ss.id <> $2`, [p.id, schedaId]);
  const daAggiornare = impatto.filter((x) => !x.giocata), intatte = impatto.filter((x) => x.giocata);
  if (daAggiornare.length && !conferma) {
    const e = httpErr(409, `la correzione cambia ${daAggiornare.length} schede in altre scene non ancora giocate: conferma per procedere`);
    e.dettaglio = { aggiornate: daAggiornare.map(({ evento, scena, data }) => ({ evento, scena, data })), intatte: intatte.length }; throw e;
  }
  const n = await copiaVociInPatologia(db, schedaId, p.id);
  for (const x of daAggiornare) {
    await db.query('delete from scena_scheda_voce where scheda_id=$1', [x.id]);
    await db.query(`insert into scena_scheda_voce (scheda_id, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep)
      select $1, ordine, sezione, voce_id, testo, scala, mb, be, su, "in", ne, is_sep from scena_scheda_voce where scheda_id=$2`, [x.id, schedaId]);
  }
  await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'correggi_revisione','patologia',$2,$3)`, [utente.id, p.id, JSON.stringify({ voci: n, scene_aggiornate: daAggiornare.length })]);
  return { ok: true, id: p.id, revisione: p.revisione, aggiornate: daAggiornare.length, intatte: intatte.length };
}
