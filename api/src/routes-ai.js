// Bozze di schede generate con l'AI e chiavi personali (cifrate). Le schede generate nascono sempre come bozza, nella libreria di chi le crea:
// un istruttore le rilegge, le corregge e le pubblica.
import { httpErr } from './services/compilazioni.js';
import { cifra, decifra } from './mfa.js';
import { chiama, leggiScheda, promptScheda, PROVIDER } from './ai.js';
import { comitatoDi, haSchede, haSchedeComitato } from './libreria-ambito.js';

const usi = new Map();     // utente → ore di utilizzo recenti (limite semplice contro abusi e consumo della quota gratuita)
const LIMITE_ORA = 12;

export function registraAi(app, pool, { soloOrg, inTransazione }, { fetchAi = (...a) => globalThis.fetch(...a) } = {}) {
  const puo = (u) => haSchede(u) || haSchedeComitato(u);
  app.get('/api/ai/stato', { preHandler: soloOrg }, async (req) => {
    if (!puo(req.utente)) throw httpErr(403, 'permesso negato');
    const { rows } = await pool.query('select provider from utente_chiave_ai where utente_id=$1', [req.utente.id]);
    return { predefinito: !!process.env.GEMINI_API_KEY, personali: rows.map((r) => r.provider) };
  });
  app.put('/api/me/chiavi-ai', { preHandler: soloOrg }, async (req) => {
    const { provider, chiave } = req.body || {};
    if (!PROVIDER.includes(provider)) throw httpErr(400, 'servizio non valido');
    if (typeof chiave !== 'string' || chiave.trim().length < 20 || chiave.length > 300) throw httpErr(400, 'chiave non valida');
    await pool.query(`insert into utente_chiave_ai (utente_id, provider, chiave_cifrata) values ($1,$2,$3) on conflict (utente_id, provider) do update set chiave_cifrata=excluded.chiave_cifrata, created_at=now()`,
      [req.utente.id, provider, cifra(chiave.trim())]);
    return { ok: true };
  });
  app.delete('/api/me/chiavi-ai/:provider', { preHandler: soloOrg }, async (req) => {
    await pool.query('delete from utente_chiave_ai where utente_id=$1 and provider=$2', [req.utente.id, req.params.provider]); return { ok: true };
  });

  app.post('/api/libreria/genera', { preHandler: soloOrg }, async (req) => {
    if (!puo(req.utente)) throw httpErr(403, 'permesso negato');
    const b = req.body || {}, argomento = String(b.argomento || '').trim().slice(0, 200), indicazioni = String(b.indicazioni || '').trim().slice(0, 1500);
    if (argomento.length < 3) throw httpErr(400, 'scrivi l\'argomento della scheda');
    const provider = b.provider || 'gemini'; if (!PROVIDER.includes(provider)) throw httpErr(400, 'servizio non valido');
    let chiave;
    const { rows: [k] } = await pool.query('select chiave_cifrata from utente_chiave_ai where utente_id=$1 and provider=$2', [req.utente.id, provider]);
    if (k) chiave = decifra(k.chiave_cifrata);
    else if (provider === 'gemini' && process.env.GEMINI_API_KEY) chiave = process.env.GEMINI_API_KEY;
    else throw httpErr(400, provider === 'gemini' ? 'la generazione con l\'AI non è ancora attiva: manca la chiave del sito' : 'aggiungi la tua chiave per questo servizio');
    const ora = Date.now(), recenti = (usi.get(req.utente.id) || []).filter((t) => ora - t < 3600e3);
    if (recenti.length >= LIMITE_ORA) throw httpErr(429, 'troppe generazioni nell\'ultima ora: riprova più tardi');
    usi.set(req.utente.id, [...recenti, ora]);
    let s;
    try { s = leggiScheda(await chiama(provider, chiave, promptScheda({ argomento, indicazioni, nVoci: Number(b.n_voci) || 20 }), fetchAi)); }
    catch (e) { throw httpErr(502, e.message); }
    return inTransazione(pool, async (db) => {
      let comitato = null;
      if (!haSchede(req.utente)) { comitato = await comitatoDi(pool, req.utente); if (!comitato) throw httpErr(400, 'il tuo comitato non risulta in anagrafica'); }
      const slug = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
      let codice = `${comitato ? slug(comitato) + '-' : 'AI-'}${slug(s.nome)}`.slice(0, 60);
      for (let n = 2; (await db.query('select 1 from patologia where codice=$1', [codice])).rowCount; n++) codice = `${codice.replace(/-\d+$/, '')}-${n}`;
      const { rows: [p] } = await db.query(`insert into patologia (codice, nome, sigla, categoria, comitato, creata_da, bozza, generata_ai) values ($1,$2,$3,$4,$5,$6,true,$7) returning *`,
        [codice, s.nome, s.sigla, s.nome, comitato, req.utente.id, provider]);
      const { rows: [sc] } = await db.query(`select id from scala_punteggio where codice='Standard'`);
      let o = 0;
      for (const sez of s.sezioni) for (const v of sez.voci) {
        const { rows: [voce] } = await db.query(`insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo=voce.testo returning id`, [v]);
        await db.query('insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,false)', [p.id, ++o, sez.sezione, voce.id, sc.id]);
      }
      return p;
    });
  });
  app.post('/api/libreria/patologie/:id/pubblica', { preHandler: soloOrg }, async (req) => {
    const { rows: [p] } = await pool.query('select id, comitato, creata_da, bozza from patologia where id=$1', [req.params.id]);
    if (!p) throw httpErr(404, 'scheda inesistente'); if (!p.bozza) return { ok: true };
    const mio = await comitatoDi(pool, req.utente);
    const lecito = req.utente.ruolo === 'admin' || p.creata_da === req.utente.id || (p.comitato ? haSchedeComitato(req.utente) && mio && mio.trim().toLowerCase() === p.comitato.trim().toLowerCase() : haSchede(req.utente));
    if (!lecito) throw httpErr(403, 'non puoi pubblicare questa scheda');
    await pool.query('update patologia set bozza=false where id=$1', [p.id]); return { ok: true };
  });
}
