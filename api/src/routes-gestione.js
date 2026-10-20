// Rotte usate dall'interfaccia di gestione (web/admin.html).
import { hashPassword } from './auth.js';
import { inTransazione } from './db.js';
import { httpErr } from './services/compilazioni.js';

const RUOLI = ['admin', 'organizzazione', 'giudice', 'giudice_master'];

export function registraGestione(app, pool, { soloOrg, soloAdmin }) {
  // ── utenti (solo admin) ──
  app.get('/api/utenti', { preHandler: soloAdmin }, async () =>
    (await pool.query('select id, email, nome, ruolo, attivo, evento_id from utente order by nome')).rows);
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
         password_hash=coalesce($5,password_hash),
         evento_id = case when $6 then $7::uuid else evento_id end where id=$1 returning id, email, nome, ruolo, attivo, evento_id`,
      [req.params.id, b.nome ?? null, b.ruolo ?? null, b.attivo ?? null, b.password ? hashPassword(b.password) : null,
       'evento_id' in b, b.evento_id || null]);
    if (!u) throw httpErr(404, 'utente inesistente');
    return u;
  });
  app.get('/api/giudici', { preHandler: soloOrg }, async () =>
    (await pool.query(`select id, nome, email, ruolo from utente where attivo and ruolo in ('giudice','giudice_master') order by nome`)).rows);

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
    const { rows: ok } = await db.query(`select id from utente where id = any($1::uuid[]) and ruolo in ('giudice','giudice_master') and attivo`, [ids]);
    if (ok.length !== new Set(ids).size) throw httpErr(400, 'solo utenti attivi con ruolo giudice o giudice master');
    await db.query('delete from assegnazione where scheda_id=$1', [req.params.id]);
    for (const u of new Set(ids)) await db.query('insert into assegnazione values ($1,$2)', [req.params.id, u]);
    return { ok: true, assegnati: ids.length };
  }));

  // ── giudice master: uno o più per scena (comanda la scena, vede e corregge tutte le sue schede, la chiude) ──
  app.get('/api/eventi/:id/master', { preHandler: soloOrg }, async (req) =>
    (await pool.query(
      `select m.scena_id, m.utente_id, u.nome from scena_master m join utente u on u.id = m.utente_id
         join scena sc on sc.id = m.scena_id where sc.evento_id = $1`, [req.params.id])).rows);
  app.put('/api/scene/:id/master', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const ids = req.body?.utenti || [];
    if (!Array.isArray(ids)) throw httpErr(400, 'utenti: elenco di id');
    const { rows: ok } = await db.query(`select id from utente where id = any($1::uuid[]) and ruolo='giudice_master' and attivo`, [ids]);
    if (ok.length !== new Set(ids).size) throw httpErr(400, 'solo utenti attivi con ruolo giudice master');
    const { rowCount } = await db.query('select 1 from scena where id=$1', [req.params.id]);
    if (!rowCount) throw httpErr(404, 'scena inesistente');
    await db.query('delete from scena_master where scena_id=$1', [req.params.id]);
    for (const u of new Set(ids)) await db.query('insert into scena_master values ($1,$2)', [req.params.id, u]);
    return { ok: true, master: ids.length };
  }));

  // ── anagrafica persone (solo organizzazione/admin: contiene dati personali) ──
  const testo = (x) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  const persona = (b) => {
    const cf = testo(b.codice_fiscale)?.toUpperCase() ?? null;
    if (cf && !/^[A-Z0-9]{16}$/.test(cf)) throw httpErr(400, 'codice fiscale: 16 caratteri (lettere e cifre)');
    const em = testo(b.email);
    if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw httpErr(400, 'email non valida');
    if (b.data_nascita && !/^\d{4}-\d{2}-\d{2}$/.test(b.data_nascita)) throw httpErr(400, 'data di nascita non valida');
    return { cognome: testo(b.cognome), nome: testo(b.nome), data_nascita: b.data_nascita || null, cf, email: em,
             comitato: testo(b.comitato), provincia: testo(b.provincia)?.toUpperCase() ?? null, note: testo(b.note) };
  };
  const COL_PERSONA = `id, cognome, nome, to_char(data_nascita,'YYYY-MM-DD') as data_nascita, codice_fiscale, email, comitato, provincia, note`;
  app.get('/api/persone', { preHandler: soloOrg }, async (req) => (await pool.query(
    `select ${COL_PERSONA}, (select count(*) from squadra_membro m where m.partecipante_id = p.id)::int as squadre
       from partecipante p
      where $1::text is null or cognome ilike '%'||$1||'%' or nome ilike '%'||$1||'%' or comitato ilike '%'||$1||'%' or codice_fiscale ilike '%'||$1||'%'
      order by cognome, nome limit 500`, [testo(req.query.q)])).rows);
  app.post('/api/persone', { preHandler: soloOrg }, async (req) => {
    const p = persona(req.body || {});
    if (!p.cognome || !p.nome) throw httpErr(400, 'cognome e nome obbligatori');
    return (await pool.query(
      `insert into partecipante (cognome, nome, data_nascita, codice_fiscale, email, comitato, provincia, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning ${COL_PERSONA}`,
      [p.cognome, p.nome, p.data_nascita, p.cf, p.email, p.comitato, p.provincia, p.note])).rows[0];
  });
  app.patch('/api/persone/:id', { preHandler: soloOrg }, async (req) => {
    const p = persona(req.body || {});
    if (!p.cognome || !p.nome) throw httpErr(400, 'cognome e nome obbligatori');
    const { rows: [r] } = await pool.query(
      `update partecipante set cognome=$2, nome=$3, data_nascita=$4, codice_fiscale=$5, email=$6, comitato=$7, provincia=$8, note=$9
        where id=$1 returning ${COL_PERSONA}`,
      [req.params.id, p.cognome, p.nome, p.data_nascita, p.cf, p.email, p.comitato, p.provincia, p.note]);
    if (!r) throw httpErr(404, 'persona inesistente');
    return r;
  });
  app.delete('/api/persone/:id', { preHandler: soloOrg }, async (req) => {
    try { await pool.query('delete from partecipante where id=$1', [req.params.id]); }
    catch (e) { if (e.code === '23503') throw httpErr(409, 'la persona fa parte di una squadra: toglila prima dalla squadra'); throw e; }
    return { ok: true };
  });
  app.get('/api/squadre/:id/membri', { preHandler: soloOrg }, async (req) => (await pool.query(
    `select m.partecipante_id, m.ruolo, p.cognome, p.nome, p.comitato, p.provincia from squadra_membro m
       join partecipante p on p.id = m.partecipante_id where m.squadra_id=$1 order by p.cognome, p.nome`, [req.params.id])).rows);
  app.put('/api/squadre/:id/membri', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const lista = req.body?.membri;
    if (!Array.isArray(lista) || lista.length > 50) throw httpErr(400, 'membri: elenco (max 50)');
    const ids = lista.map((m) => m?.partecipante_id);
    if (new Set(ids).size !== ids.length) throw httpErr(400, 'persona ripetuta');
    const { rowCount: sq } = await db.query('select 1 from squadra where id=$1', [req.params.id]);
    if (!sq) throw httpErr(404, 'squadra inesistente');
    const { rows: ok } = await db.query('select id from partecipante where id = any($1::uuid[])', [ids]);
    if (ok.length !== ids.length) throw httpErr(400, 'persona inesistente');
    await db.query('delete from squadra_membro where squadra_id=$1', [req.params.id]);
    for (const m of lista) await db.query('insert into squadra_membro values ($1,$2,$3)', [req.params.id, m.partecipante_id, testo(m.ruolo)]);
    return { ok: true, membri: lista.length };
  }));

  // ── evento / scena / scheda ──
  app.patch('/api/eventi/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (b.mappa_url && !/^https:\/\/(www\.)?google\.com\/maps\//.test(b.mappa_url.trim())) throw httpErr(400, 'la mappa deve essere un indirizzo https://www.google.com/maps/… (Condividi → Incorpora mappa)');
    const { rows: [e] } = await pool.query(
      `update evento set mappa_url = case when $9 then nullif(trim($10),'') else mappa_url end, codice=coalesce($8,codice), nome=coalesce($2,nome), titolo_stampa=coalesce($3,titolo_stampa), luogo=coalesce($4,luogo),
         data=coalesce($5::date,data), tipo=coalesce($6,tipo), archiviato=coalesce($7,archiviato), attivo = case when coalesce($7,archiviato) then false else attivo end, updated_at=now()
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.titolo_stampa ?? null, b.luogo ?? null, b.data ?? null, b.tipo ?? null, b.archiviato ?? null, b.codice?.trim() || null, 'mappa_url' in b, b.mappa_url ?? '']);
    if (!e) throw httpErr(404, 'evento inesistente');
    return e;
  });
  app.patch('/api/scene/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [s] } = await pool.query(
      `update scena set titolo=coalesce($2,titolo), ordine=coalesce($3,ordine),
         indirizzo = case when $4 then nullif(trim($5),'') else indirizzo end,
         lat = case when $6 then $7::numeric else lat end, lng = case when $6 then $8::numeric else lng end where id=$1 returning *`,
      [req.params.id, b.titolo ?? null, b.ordine ?? null, 'indirizzo' in b, b.indirizzo ?? '',
       'lat' in b || 'lng' in b, b.lat === '' ? null : (b.lat ?? null), b.lng === '' ? null : (b.lng ?? null)]);
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
      `update patologia set nome=coalesce($2,nome), sigla=coalesce($3,sigla), is_bls=coalesce($4,is_bls), is_master=coalesce($5,is_master), is_diu=coalesce($6,is_diu),
         categoria = case when $7 then nullif(trim($8),'') else categoria end, categoria2 = case when $9 then nullif(trim($10),'') else categoria2 end
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.sigla ?? null, b.is_bls ?? null, b.is_master ?? null, b.is_diu ?? null,
        'categoria' in b, b.categoria ?? '', 'categoria2' in b, b.categoria2 ?? '']);
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
