// Rotte usate dall'interfaccia di gestione (web/admin.html).
import { hashPassword } from './auth.js';
import { inTransazione } from './db.js';
import { httpErr } from './services/compilazioni.js';

const RUOLI = ['admin', 'organizzazione', 'giudice'];

export function registraGestione(app, pool, { soloOrg, soloAdmin }) {
  // ── utenti (solo admin) ──
  app.get('/api/utenti', { preHandler: soloAdmin }, async () =>
    (await pool.query('select id, email, nome, ruolo, attivo from utente order by nome')).rows);
  app.post('/api/utenti', { preHandler: soloAdmin }, async (req) => {
    const { email, nome, ruolo = 'giudice', password } = req.body || {};
    if (!email || !nome || !password || password.length < 8) throw httpErr(400, 'email, nome e password (min. 8 caratteri) obbligatori');
    if (!RUOLI.includes(ruolo)) throw httpErr(400, 'ruolo non valido');
    try {
      return (await pool.query(
        'insert into utente (email, nome, ruolo, password_hash) values ($1,$2,$3,$4) returning id, email, nome, ruolo, attivo',
        [email.trim(), nome.trim(), ruolo, hashPassword(password)])).rows[0];
    } catch (e) { if (e.code === '23505') throw httpErr(409, 'email già registrata'); throw e; }
  });
  app.patch('/api/utenti/:id', { preHandler: soloAdmin }, async (req) => {
    const b = req.body || {};
    if (req.params.id === req.utente.id && (b.attivo === false || (b.ruolo && b.ruolo !== 'admin')))
      throw httpErr(400, 'non puoi disattivare o declassare te stesso');
    if (b.ruolo && !RUOLI.includes(b.ruolo)) throw httpErr(400, 'ruolo non valido');
    if (b.password && b.password.length < 8) throw httpErr(400, 'password: minimo 8 caratteri');
    const { rows: [u] } = await pool.query(
      `update utente set nome=coalesce($2,nome), ruolo=coalesce($3::ruolo_utente,ruolo), attivo=coalesce($4,attivo),
         password_hash=coalesce($5,password_hash) where id=$1 returning id, email, nome, ruolo, attivo`,
      [req.params.id, b.nome ?? null, b.ruolo ?? null, b.attivo ?? null, b.password ? hashPassword(b.password) : null]);
    if (!u) throw httpErr(404, 'utente inesistente');
    return u;
  });
  app.get('/api/giudici', { preHandler: soloOrg }, async () =>
    (await pool.query(`select id, nome, email from utente where attivo and ruolo='giudice' order by nome`)).rows);

  // ── assegnazioni giudici → schede ──
  app.get('/api/eventi/:id/assegnazioni', { preHandler: soloOrg }, async (req) =>
    (await pool.query(
      `select a.scheda_id, a.utente_id, u.nome from assegnazione a
         join utente u on u.id = a.utente_id
         join scena_scheda s on s.id = a.scheda_id join scena sc on sc.id = s.scena_id
        where sc.evento_id = $1`, [req.params.id])).rows);
  app.put('/api/schede/:id/assegnazioni', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const ids = req.body?.utenti || [];
    if (!Array.isArray(ids)) throw httpErr(400, 'utenti: elenco di id');
    const { rows: ok } = await db.query(`select id from utente where id = any($1::uuid[]) and ruolo='giudice' and attivo`, [ids]);
    if (ok.length !== new Set(ids).size) throw httpErr(400, 'solo utenti attivi con ruolo giudice');
    await db.query('delete from assegnazione where scheda_id=$1', [req.params.id]);
    for (const u of new Set(ids)) await db.query('insert into assegnazione values ($1,$2)', [req.params.id, u]);
    return { ok: true, assegnati: ids.length };
  }));

  // ── evento / scena / scheda ──
  app.patch('/api/eventi/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [e] } = await pool.query(
      `update evento set nome=coalesce($2,nome), titolo_stampa=coalesce($3,titolo_stampa), luogo=coalesce($4,luogo),
         data=coalesce($5::date,data), tipo=coalesce($6,tipo), archiviato=coalesce($7,archiviato), attivo = case when coalesce($7,archiviato) then false else attivo end, updated_at=now()
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.titolo_stampa ?? null, b.luogo ?? null, b.data ?? null, b.tipo ?? null, b.archiviato ?? null]);
    if (!e) throw httpErr(404, 'evento inesistente');
    return e;
  });
  app.patch('/api/scene/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [s] } = await pool.query(
      `update scena set titolo=coalesce($2,titolo), ordine=coalesce($3,ordine) where id=$1 returning *`,
      [req.params.id, b.titolo ?? null, b.ordine ?? null]);
    if (!s) throw httpErr(404, 'scena inesistente');
    return s;
  });
  app.patch('/api/schede/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [s] } = await pool.query(
      `update scena_scheda set titolo=coalesce($2,titolo), simulatore=coalesce($3,simulatore),
         parametri=coalesce($4::jsonb,parametri) where id=$1 returning *`,
      [req.params.id, b.titolo ?? null, b.simulatore ?? null, b.parametri ? JSON.stringify(b.parametri) : null]);
    if (!s) throw httpErr(404, 'scheda inesistente');
    return s;
  });
  // eliminazioni: vietate se esistono valutazioni vere; le compilazioni vuote (o con sole risposte annullate) si ripuliscono
  // (le chiavi esterne `restrict` sono la rete di sicurezza contro qualunque corsa tra controllo e cancellazione)
  const eliminaConControllo = (condizione, tabella, errore) => async (req) => inTransazione(pool, async (db) => {
    const { rows: [{ n }] } = await db.query(
      `select count(*)::int n from risposta r join compilazione c on c.id=r.compilazione_id
         join scena_scheda s on s.id=c.scheda_id where r.livello is not null and ${condizione}`, [req.params.id]);
    if (n > 0) throw httpErr(409, errore);
    await db.query(`delete from risposta where compilazione_id in (select c.id from compilazione c join scena_scheda s on s.id=c.scheda_id where ${condizione})`, [req.params.id]);
    await db.query(`delete from compilazione where scheda_id in (select s.id from scena_scheda s where ${condizione})`, [req.params.id]);
    await db.query(`delete from ${tabella} where id=$1`, [req.params.id]);
    return { ok: true };
  });
  app.delete('/api/schede/:id', { preHandler: soloOrg }, eliminaConControllo('s.id=$1', 'scena_scheda', 'la scheda ha già valutazioni: non eliminabile'));
  app.delete('/api/scene/:id', { preHandler: soloOrg }, eliminaConControllo('s.scena_id=$1', 'scena', 'la scena ha già valutazioni: non eliminabile'));

  // ── libreria: scale e patologie modificabili ──
  app.post('/api/libreria/scale', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (!b.codice) throw httpErr(400, 'codice obbligatorio');
    const v = (x) => (x === '' || x === undefined ? null : x);
    return (await pool.query(
      `insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6)
       on conflict (codice) do update set mb=excluded.mb, be=excluded.be, su=excluded.su, "in"=excluded."in", ne=excluded.ne
       returning *`, [b.codice, v(b.mb), v(b.be), v(b.su), v(b.in), v(b.ne)])).rows[0];
  });
  app.put('/api/libreria/patologie/:id', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const b = req.body || {};
    const { rows: [p] } = await db.query(
      `update patologia set nome=coalesce($2,nome), sigla=coalesce($3,sigla), is_bls=coalesce($4,is_bls), is_master=coalesce($5,is_master)
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.sigla ?? null, b.is_bls ?? null, b.is_master ?? null]);
    if (!p) throw httpErr(404, 'patologia inesistente');
    if (Array.isArray(b.voci)) {          // sostituisce l'elenco; le scene già composte non cambiano (snapshot)
      await db.query('delete from patologia_voce where patologia_id=$1', [p.id]);
      let o = 0;
      for (const v of b.voci) {
        const { rows: [voce] } = await db.query(
          `insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo=voce.testo returning id`, [v.testo.trim()]);
        const { rows: [sc] } = await db.query('select id from scala_punteggio where codice=$1', [v.scala || 'Standard']);
        if (!sc) throw httpErr(400, `scala inesistente: ${v.scala}`);
        await db.query(`insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,$6)`,
          [p.id, ++o, v.sezione, voce.id, sc.id, !!v.is_sep]);
      }
    }
    return p;
  }));
  app.delete('/api/libreria/patologie/:id', { preHandler: soloOrg }, async (req) => {
    try { await pool.query('delete from patologia where id=$1', [req.params.id]); }
    catch (e) { if (e.code === '23503') throw httpErr(409, 'patologia usata in una scena: non eliminabile'); throw e; }
    return { ok: true };
  });
}
