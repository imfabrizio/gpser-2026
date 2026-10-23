// Esami: sessioni, prove con candidato principale e fino a due secondari. La scheda si compila una volta e vale per tutti;
// su una singola voce si può dare un valore diverso a un candidato. L'esito è Superato / Non superato.
import { httpErr } from './services/compilazioni.js';
import { valutaEsito } from './esito.js';
import { generaEsitoPdf } from './pdf/esito.js';
import { generaRiepilogoEsamiPdf } from './pdf/riepilogo-esami.js';

const UUID = /^[0-9a-f-]{36}$/i;
const SOGLIA_DEFAULT = 75;       // senza fasce proprie della scheda
const id = (v, nome = 'id') => { if (!UUID.test(v || '')) throw httpErr(400, `${nome} non valido`); return v; };
const L = { NE: 'ne', SU: 'su', MB: 'mb' };

export function esitoCandidato(prova, cand, risposte) {
  const comuni = new Map(), propri = new Map();
  for (const r of risposte) (r.candidato_id === null ? comuni : r.candidato_id === cand.id ? propri : null)?.set(r.ordine, r.livello);
  let punti = 0, massimo = 0, date = 0;
  const righe = prova.voci.map((v) => {
    const livello = propri.get(v.ordine) ?? comuni.get(v.ordine) ?? null;
    const max = Math.max(v.ne ?? 0, v.su ?? 0, v.mb ?? 0), p = livello ? v[L[livello]] ?? 0 : 0;
    punti += p; massimo += max; if (livello) date++;
    return { ordine: v.ordine, sezione: v.sezione, testo: v.testo, livello, punti: p, max, diverso: propri.has(v.ordine), tre: true };
  });
  const erroreGrave = cand.errore_grave ?? prova.errore_grave;
  const e = valutaEsito({ punti, massimo, fasce: prova.fasce, soglia: SOGLIA_DEFAULT });
  return { punti, massimo, perc: e.perc, giudizio: e.giudizio, sogliaPunti: e.sogliaPunti, erroreGrave, completa: date === prova.voci.length,
    superato: !erroreGrave && !!e.superato, righe };
}

export function registraEsami(app, pool, { soloOrg }) {
  const carica = async (provaId) => {
    const { rows: [p] } = await pool.query('select * from prova_esame where id=$1', [provaId]);
    if (!p) throw httpErr(404, 'prova inesistente');
    const { rows: cands } = await pool.query('select * from candidato_esame where prova_id=$1 order by ordine', [p.id]);
    const { rows: risp } = await pool.query('select candidato_id, ordine, livello from risposta_esame where prova_id=$1', [p.id]);
    p.candidati = cands.map((c) => ({ ...c, esito: esitoCandidato(p, c, risp) }));
    p.risposte = risp;
    return p;
  };
  const leggero = (p) => ({ id: p.id, titolo: p.titolo, stato: p.stato, valutatore: p.valutatore, errore_grave: p.errore_grave,
    candidati: p.candidati.map((c) => ({ id: c.id, nome: c.nome, comitato: c.comitato, ruolo: c.ruolo, esito: { punti: c.esito.punti, massimo: c.esito.massimo, giudizio: c.esito.giudizio, superato: c.esito.superato, completa: c.esito.completa, erroreGrave: c.esito.erroreGrave } })) });

  app.get('/api/esami/sessioni', { preHandler: soloOrg }, async () => (await pool.query(
    `select s.id, s.nome, to_char(s.data,'YYYY-MM-DD') as data, s.luogo, (select count(*)::int from prova_esame p where p.sessione_id=s.id) as prove
       from sessione_esame s order by s.data desc nulls last, s.created_at desc`)).rows);
  app.post('/api/esami/sessioni', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, nome = String(b.nome || '').trim();
    if (!nome || nome.length > 150) throw httpErr(400, 'nome obbligatorio (max 150 caratteri)');
    if (b.data && !/^\d{4}-\d{2}-\d{2}$/.test(b.data)) throw httpErr(400, 'data non valida');
    return (await pool.query('insert into sessione_esame (nome, data, luogo, creato_da) values ($1,$2,$3,$4) returning id, nome, luogo',
      [nome, b.data || null, String(b.luogo || '').trim() || null, req.utente.id])).rows[0];
  });
  app.delete('/api/esami/sessioni/:id', { preHandler: soloOrg }, async (req) => {
    const { rowCount } = await pool.query('delete from sessione_esame where id=$1', [id(req.params.id)]);
    if (!rowCount) throw httpErr(404, 'sessione inesistente'); return { ok: true };
  });
  app.get('/api/esami/sessioni/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [s] } = await pool.query(`select id, nome, to_char(data,'YYYY-MM-DD') as data, luogo from sessione_esame where id=$1`, [id(req.params.id)]);
    if (!s) throw httpErr(404, 'sessione inesistente');
    const { rows } = await pool.query('select id from prova_esame where sessione_id=$1 order by ordine, created_at', [s.id]);
    return { sessione: s, prove: (await Promise.all(rows.map((r) => carica(r.id)))).map(leggero) };
  });
  // schede della libreria utilizzabili negli esami: a tre livelli (non eseguito / sufficiente / corretto)
  app.get('/api/esami/schede', { preHandler: soloOrg }, async () => (await pool.query(
    `select p.id, p.nome, p.categoria from patologia p where p.comitato is null
       and exists (select 1 from patologia_voce where patologia_id=p.id)
       and not exists (select 1 from patologia_voce pv join scala_punteggio sp on sp.id=pv.scala_id where pv.patologia_id=p.id and (sp.be is not null or sp."in" is not null))
     order by p.categoria nulls last, p.nome`)).rows);
  app.get('/api/esami/persone', { preHandler: soloOrg }, async (req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return [];
    return (await pool.query(`select id, nome, cognome, comitato from partecipante where (cognome || ' ' || nome) ilike '%' || $1 || '%' or (nome || ' ' || cognome) ilike '%' || $1 || '%' order by cognome, nome limit 15`, [q])).rows;
  });
  app.post('/api/esami/sessioni/:id/prove', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, sid = id(req.params.id);
    const cands = Array.isArray(b.candidati) ? b.candidati.filter((c) => c && String(c.nome || '').trim()) : [];
    if (cands.length < 1 || cands.length > 3) throw httpErr(400, 'da 1 a 3 candidati (il primo è il principale)');
    const { rows: [sess] } = await pool.query('select 1 from sessione_esame where id=$1', [sid]);
    if (!sess) throw httpErr(404, 'sessione inesistente');
    const { rows: [pat] } = await pool.query('select * from patologia where id=$1', [id(b.patologiaId, 'scheda')]);
    if (!pat) throw httpErr(404, 'scheda inesistente');
    const { rows: voci } = await pool.query(
      `select pv.ordine, pv.sezione, v.testo, sp.ne, sp.su, sp.mb, sp.be, sp."in" from patologia_voce pv join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id
        where pv.patologia_id=$1 order by pv.ordine`, [pat.id]);
    if (!voci.length || voci.some((v) => v.be !== null || v.in !== null)) throw httpErr(400, 'scheda non adatta agli esami: servono i tre livelli non eseguito / sufficiente / corretto');
    const { rows: [u] } = await pool.query('select nome as n from utente where id=$1', [req.utente.id]);
    const val = String(b.valutatore || '').trim() || u?.n || null;
    const { rows: [p] } = await pool.query(
      `insert into prova_esame (sessione_id, patologia_id, titolo, fasce, voci, valutatore, ordine)
       values ($1,$2,$3,$4,$5,$6,(select count(*) from prova_esame where sessione_id=$1)) returning id`,
      [sid, pat.id, pat.nome, pat.fasce ? JSON.stringify(pat.fasce) : null, JSON.stringify(voci.map(({ ordine, sezione, testo, ne, su, mb }) => ({ ordine, sezione, testo, ne, su, mb }))), val]);
    let i = 0;
    for (const c of cands) {
      await pool.query('insert into candidato_esame (prova_id, ruolo, nome, comitato, partecipante_id, ordine) values ($1,$2,$3,$4,$5,$6)',
        [p.id, i === 0 ? 'principale' : 'secondario', String(c.nome).trim().slice(0, 120), String(c.comitato || '').trim().slice(0, 120) || null,
         UUID.test(c.partecipanteId || '') ? c.partecipanteId : null, i]);
      i++;
    }
    return { id: p.id };
  });
  app.get('/api/esami/prove/:id', { preHandler: soloOrg }, async (req) => carica(id(req.params.id)));
  app.delete('/api/esami/prove/:id', { preHandler: soloOrg }, async (req) => {
    const { rowCount } = await pool.query('delete from prova_esame where id=$1', [id(req.params.id)]);
    if (!rowCount) throw httpErr(404, 'prova inesistente'); return { ok: true };
  });
  app.patch('/api/esami/prove/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, pid = id(req.params.id);
    const p = await carica(pid);
    if (p.stato === 'chiusa' && b.stato !== 'bozza') throw httpErr(409, 'prova chiusa: riaprila per modificarla');
    if ('errore_grave' in b && typeof b.errore_grave !== 'boolean') throw httpErr(400, 'errore_grave: vero o falso');
    if (b.stato && !['bozza', 'chiusa'].includes(b.stato)) throw httpErr(400, 'stato non valido');
    if (b.stato === 'chiusa' && p.candidati.some((c) => !c.esito.completa)) throw httpErr(409, 'completa tutte le voci prima di chiudere la prova');
    await pool.query(`update prova_esame set errore_grave = coalesce($2, errore_grave), valutatore = coalesce($3, valutatore),
        stato = coalesce($4, stato), chiusa_at = case when $4 = 'chiusa' then now() when $4 = 'bozza' then null else chiusa_at end where id=$1`,
      [pid, b.errore_grave ?? null, b.valutatore ? String(b.valutatore).slice(0, 120) : null, b.stato ?? null]);
    return carica(pid);
  });
  app.patch('/api/esami/candidati/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, cid = id(req.params.id);
    const { rows: [c] } = await pool.query('select c.*, p.stato from candidato_esame c join prova_esame p on p.id=c.prova_id where c.id=$1', [cid]);
    if (!c) throw httpErr(404, 'candidato inesistente');
    if (c.stato === 'chiusa') throw httpErr(409, 'prova chiusa: riaprila per modificarla');
    if ('errore_grave' in b && b.errore_grave !== null && typeof b.errore_grave !== 'boolean') throw httpErr(400, 'errore_grave: vero, falso o nullo');
    await pool.query('update candidato_esame set errore_grave = case when $2 then $3 else errore_grave end, nome = coalesce($4, nome), comitato = case when $5 then $6 else comitato end where id=$1',
      [cid, 'errore_grave' in b, b.errore_grave ?? null, b.nome ? String(b.nome).trim().slice(0, 120) : null, 'comitato' in b, String(b.comitato || '').trim() || null]);
    return carica(c.prova_id);
  });
  // risposta comune (candidato_id assente) o valore diverso per un solo candidato; livello null = annulla
  app.put('/api/esami/prove/:id/risposte', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, pid = id(req.params.id);
    const p = await carica(pid);
    if (p.stato === 'chiusa') throw httpErr(409, 'prova chiusa: riaprila per modificarla');
    if (!p.voci.some((v) => v.ordine === b.ordine)) throw httpErr(400, 'voce inesistente');
    if (b.livello !== null && !(b.livello in L)) throw httpErr(400, 'livello: NE, SU o MB');
    const cid = b.candidato_id ? id(b.candidato_id, 'candidato') : null;
    if (cid && !p.candidati.some((c) => c.id === cid)) throw httpErr(400, 'candidato non della prova');
    const z = '00000000-0000-0000-0000-000000000000';
    if (b.livello === null) await pool.query('delete from risposta_esame where prova_id=$1 and coalesce(candidato_id, $3::uuid)=$2::uuid and ordine=$4', [pid, cid ?? z, z, b.ordine]);
    else await pool.query(`insert into risposta_esame (prova_id, candidato_id, ordine, livello) values ($1,$2,$3,$4)
        on conflict (prova_id, coalesce(candidato_id, '00000000-0000-0000-0000-000000000000'::uuid), ordine) do update set livello = excluded.livello`, [pid, cid, b.ordine, b.livello]);
    return carica(pid);
  });
  app.get('/api/esami/prove/:id/esito.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const p = await carica(id(req.params.id));
    const c = p.candidati.find((x) => x.id === req.query.candidato) || p.candidati[0];
    const { rows: [s] } = await pool.query(`select nome, luogo, to_char(data,'YYYY-MM-DD') as data from sessione_esame where id=$1`, [p.sessione_id]);
    const principale = p.candidati.find((x) => x.ruolo === 'principale');
    const nota = c.ruolo === 'secondario' ? `valutato con ${principale?.nome || 'il candidato principale'}` : null;
    const pdf = await generaEsitoPdf({ evento: { ...s, tipo: 'esame' }, scheda: p.titolo, candidato: c, giudice: p.valutatore,
      voci: c.esito.righe, punti: c.esito.punti, massimo: c.esito.massimo, soglia: SOGLIA_DEFAULT, fasce: p.fasce, erroreGrave: !!c.esito.erroreGrave, nota });
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="esito.pdf"').send(pdf);
  });
  app.get('/api/esami/sessioni/:id/riepilogo.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const { rows: [s] } = await pool.query(`select id, nome, luogo, to_char(data,'YYYY-MM-DD') as data from sessione_esame where id=$1`, [id(req.params.id)]);
    if (!s) throw httpErr(404, 'sessione inesistente');
    const { rows } = await pool.query('select id from prova_esame where sessione_id=$1 order by ordine, created_at', [s.id]);
    const pdf = await generaRiepilogoEsamiPdf({ sessione: s, prove: await Promise.all(rows.map((r) => carica(r.id))) });
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="riepilogo-esami.pdf"').send(pdf);
  });
}
