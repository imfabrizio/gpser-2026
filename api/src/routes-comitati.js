// Comitati e unità territoriali: ricerca con suggerimenti (per tutti gli utenti registrati), gestione e riconduzione dei nomi liberi (area Anagrafiche).
import { httpErr } from './services/compilazioni.js';
import { elenco, norm, somiglianza, svuotaCache, trova } from './comitati.js';

const UUID = /^[0-9a-f-]{36}$/i;
const t = (v, max = 120) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const TABELLE = ['utente', 'partecipante', 'squadra', 'richiesta_accesso', 'patologia', 'candidato_esame'];

export function registraComitati(app, pool, { soloOrg }) {
  // ricerca per le prime lettere: nome, alias o provincia; con "provincia" si restringe
  app.get('/api/comitati/cerca', async (req) => {
    const q = norm(req.query.q || ''), prov = String(req.query.provincia || '').trim().toUpperCase();
    const tutti = await elenco(pool);
    return tutti.filter((c) => (!prov || (c.provincia || '').toUpperCase() === prov) && (!q || norm(c.nome).includes(q) || c.alias.some((a) => norm(a).includes(q)) || (c.provincia || '').toLowerCase() === q))
      .sort((a, b) => (norm(a.nome).startsWith(q) ? 0 : 1) - (norm(b.nome).startsWith(q) ? 0 : 1) || a.nome.localeCompare(b.nome)).slice(0, 15)
      .map(({ nome, provincia, regione, unita }) => ({ nome, provincia, regione, unita: unita.length ? unita : [nome] }));
  });
  app.get('/api/comitati', { preHandler: soloOrg }, async () => elenco(pool));
  const pulisci = (b) => ({ nome: t(b.nome), regione: t(b.regione, 60), provincia: t(b.provincia, 4)?.toUpperCase() ?? null,
    alias: [...new Set((Array.isArray(b.alias) ? b.alias : []).map((a) => t(a)).filter(Boolean))],
    unita: [...new Set((Array.isArray(b.unita) ? b.unita : []).map((a) => t(a)).filter(Boolean))] });
  const salva = async (db, id, c) => {
    if (!c.nome) throw httpErr(400, 'nome del comitato obbligatorio');
    if (id) await db.query('update comitato set nome=$2, regione=$3, provincia=$4, alias=$5 where id=$1', [id, c.nome, c.regione, c.provincia, c.alias]);
    else ({ rows: [{ id }] } = await db.query(`insert into comitato (nome, regione, provincia, alias) values ($1,$2,$3,$4)
        on conflict (lower(nome)) do update set regione = coalesce(excluded.regione, comitato.regione), provincia = coalesce(excluded.provincia, comitato.provincia),
          alias = (select array(select distinct unnest(comitato.alias || excluded.alias))) returning id`, [c.nome, c.regione, c.provincia, c.alias]));
    if (c.unita) { await db.query('delete from unita_territoriale where comitato_id=$1 and lower(nome) <> all($2::text[])', [id, c.unita.map((u) => u.toLowerCase())]);
      for (const u of c.unita) await db.query('insert into unita_territoriale (comitato_id, nome) values ($1,$2) on conflict do nothing', [id, u]); }
    svuotaCache(); return id;
  };
  app.post('/api/comitati', { preHandler: soloOrg }, async (req) => { const id = await salva(pool, null, pulisci(req.body || {})); return (await elenco(pool)).find((c) => c.id === id); });
  app.patch('/api/comitati/:id', { preHandler: soloOrg }, async (req) => {
    if (!UUID.test(req.params.id)) throw httpErr(400, 'id non valido');
    const { rows: [v] } = await pool.query('select nome from comitato where id=$1', [req.params.id]); if (!v) throw httpErr(404, 'comitato inesistente');
    const c = pulisci(req.body || {});
    try { await salva(pool, req.params.id, c); } catch (e) { if (e.code === '23505') throw httpErr(409, 'esiste già un comitato con questo nome'); throw e; }
    if (v.nome !== c.nome) for (const tb of TABELLE) await pool.query(`update ${tb} set comitato=$2 where lower(comitato)=lower($1)`, [v.nome, c.nome]);   // rinomina ovunque
    return (await elenco(pool)).find((x) => x.id === req.params.id);
  });
  app.delete('/api/comitati/:id', { preHandler: soloOrg }, async (req) => {
    if (!UUID.test(req.params.id)) throw httpErr(400, 'id non valido');
    const { rowCount } = await pool.query('delete from comitato where id=$1', [req.params.id]); svuotaCache();
    if (!rowCount) throw httpErr(404, 'comitato inesistente'); return { ok: true };
  });
  // import da testo: una riga per comitato, campi separati da ; o tab → nome;provincia;regione;unità1|unità2
  app.post('/api/comitati/importa', { preHandler: soloOrg }, async (req) => {
    const righe = String(req.body?.testo || '').split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (!righe.length) throw httpErr(400, 'incolla almeno una riga');
    if (righe.length > 3000) throw httpErr(400, 'troppe righe (max 3000)');
    let n = 0;
    const client = await pool.connect();
    try {
      await client.query('begin');
      for (const r of righe) {
        const [nome, provincia, regione, unita] = r.split(/[;\t]/).map((x) => x.trim());
        if (/^(comitato|nome)$/i.test(nome)) continue;                              // intestazione
        await salva(client, null, pulisci({ nome, provincia, regione, unita: unita ? unita.split('|') : [] })); n++;
      }
      await client.query('commit');
    } catch (e) { await client.query('rollback'); throw e.statusCode ? e : httpErr(400, 'import non riuscito: ' + e.message); } finally { client.release(); }
    return { importati: n };
  });
  // scritture libere che non coincidono con nessun comitato ufficiale, con il suggerimento più vicino
  app.get('/api/comitati/da-ricondurre', { preHandler: soloOrg }, async () => {
    const tutti = await elenco(pool);
    if (!tutti.length) return [];
    const uniti = TABELLE.map((tb) => `select comitato from ${tb} where comitato is not null and trim(comitato) <> ''`).join(' union all ');
    const { rows } = await pool.query(`select comitato as testo, count(*)::int as n from (${uniti}) x group by comitato order by n desc`);
    const out = [];
    for (const r of rows) {
      if (await trova(pool, r.testo)) { if (tutti.some((c) => c.nome === r.testo)) continue; }   // già riconoscibile ma scritto in modo diverso: va comunque ricondotto
      const sugg = tutti.map((c) => ({ id: c.id, nome: c.nome, p: Math.max(somiglianza(r.testo, c.nome), ...c.alias.map((a) => somiglianza(r.testo, a))) }))
        .filter((x) => x.p >= 0.6).sort((a, b) => b.p - a.p).slice(0, 3);
      out.push({ testo: r.testo, n: r.n, suggerimenti: sugg });
    }
    return out;
  });
  // ricondurre: tutte le scritture "da" diventano il comitato ufficiale, e "da" diventa un modo riconosciuto di scriverlo
  app.post('/api/comitati/ricondurre', { preHandler: soloOrg }, async (req) => {
    const da = t(req.body?.da), id = req.body?.comitatoId;
    if (!da || !UUID.test(id || '')) throw httpErr(400, 'indica il testo e il comitato ufficiale');
    const { rows: [c] } = await pool.query('select nome from comitato where id=$1', [id]); if (!c) throw httpErr(404, 'comitato inesistente');
    let toccate = 0;
    for (const tb of TABELLE) toccate += (await pool.query(`update ${tb} set comitato=$2 where lower(trim(comitato))=lower($1)`, [da, c.nome])).rowCount;
    if (norm(da) !== norm(c.nome)) await pool.query('update comitato set alias = (select array(select distinct unnest(alias || $2::text[]))) where id=$1', [id, [da]]);
    svuotaCache(); return { aggiornate: toccate };
  });
}
