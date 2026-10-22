// Documentazione: regolamenti, comunicazioni, manuali, formazione. Visibile a tutti gli utenti registrati; la modifica richiede l'area Documentazione.
import { httpErr } from './services/compilazioni.js';

export const CATEGORIE_DOC = { regolamento: 'Regolamento gara', comunicazioni: 'Comunicazioni', manuali: 'Manuali di primo soccorso', formazione: 'Formazione', altro: 'Altro' };
const UUID = /^[0-9a-f-]{36}$/i;

export function registraDocumenti(app, pool, { soloOrg }) {
  const pulisci = (b, nuovo) => {
    const o = {};
    if (nuovo || 'categoria' in b) { if (!(b.categoria in CATEGORIE_DOC)) throw httpErr(400, 'categoria non valida'); o.categoria = b.categoria; }
    if (nuovo || 'titolo' in b) { const t = String(b.titolo || '').trim(); if (!t || t.length > 150) throw httpErr(400, 'titolo obbligatorio (max 150 caratteri)'); o.titolo = t; }
    if (nuovo || 'url' in b) { const u = String(b.url || '').trim(); if (!/^https:\/\/[^\s]+$/.test(u) || u.length > 2000) throw httpErr(400, 'il collegamento deve iniziare con https://'); o.url = u; }
    if ('descrizione' in b) o.descrizione = String(b.descrizione || '').trim().slice(0, 500) || null;
    if ('ordine' in b) { const n = Number(b.ordine); if (!Number.isInteger(n)) throw httpErr(400, 'ordine: numero intero'); o.ordine = n; }
    return o;
  };
  app.get('/api/documenti', async () => ({
    categorie: CATEGORIE_DOC,
    documenti: (await pool.query('select id, categoria, titolo, descrizione, url, ordine from documento order by categoria, ordine, titolo')).rows,
  }));
  app.post('/api/documenti', { preHandler: soloOrg }, async (req) => {
    const o = pulisci(req.body || {}, true);
    return (await pool.query('insert into documento (categoria, titolo, descrizione, url, ordine, creato_da) values ($1,$2,$3,$4,coalesce($5,0),$6) returning *',
      [o.categoria, o.titolo, o.descrizione ?? null, o.url, o.ordine ?? null, req.utente.id])).rows[0];
  });
  app.patch('/api/documenti/:id', { preHandler: soloOrg }, async (req) => {
    if (!UUID.test(req.params.id)) throw httpErr(400, 'id non valido');
    const o = pulisci(req.body || {}, false), k = Object.keys(o);
    if (!k.length) throw httpErr(400, 'niente da modificare');
    const { rows: [d] } = await pool.query(`update documento set ${k.map((c, i) => `${c}=$${i + 2}`).join(', ')} where id=$1 returning *`, [req.params.id, ...k.map((c) => o[c])]);
    if (!d) throw httpErr(404, 'documento inesistente');
    return d;
  });
  app.delete('/api/documenti/:id', { preHandler: soloOrg }, async (req) => {
    if (!UUID.test(req.params.id)) throw httpErr(400, 'id non valido');
    const { rowCount } = await pool.query('delete from documento where id=$1', [req.params.id]);
    if (!rowCount) throw httpErr(404, 'documento inesistente');
    return { ok: true };
  });
}
