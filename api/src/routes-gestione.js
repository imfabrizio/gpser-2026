import crypto from 'node:crypto';
// Rotte usate dall'interfaccia di gestione (web/admin.html).
import { hashPassword } from './auth.js';
import { inTransazione } from './db.js';
import { httpErr } from './services/compilazioni.js';
import { AREE } from './permessi.js';
import { controllaScheda } from './libreria-ambito.js';
import { decifra } from './mfa.js';
import { verificaCodiceFiscale } from './codice-fiscale.js';
import { datiCf, hashCf } from './anagrafica.js';


export function registraGestione(app, pool, { soloOrg, soloAdmin }) {
  // ── ruoli e utenti (solo admin) ──
  const slug = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const areeValide = (a) => { if (!Array.isArray(a) || a.some((x) => !(x in AREE))) throw httpErr(400, 'aree non valide'); return [...new Set(a)]; };
  app.get('/api/ruoli', { preHandler: soloAdmin }, async () => ({ aree: AREE, ruoli: (await pool.query(
    `select r.codice, r.nome, r.sistema, r.aree, (select count(*)::int from utente u where u.ruolo = r.codice) as utenti from ruolo r order by r.sistema desc, r.nome`)).rows }));
  app.post('/api/ruoli', { preHandler: soloAdmin }, async (req) => {
    const nome = String(req.body?.nome || '').trim().slice(0, 60); const codice = slug(nome);
    if (!codice || codice === 'admin') throw httpErr(400, 'nome del ruolo non valido');
    const aree = areeValide(req.body?.aree ?? []);
    try { return (await pool.query('insert into ruolo (codice, nome, aree) values ($1,$2,$3) returning codice, nome, sistema, aree', [codice, nome, aree])).rows[0]; }
    catch (e) { if (e.code === '23505') throw httpErr(409, 'esiste già un ruolo con questo nome'); throw e; }
  });
  app.put('/api/ruoli/:codice', { preHandler: soloAdmin }, async (req) => {
    const { rows: [r] } = await pool.query('select * from ruolo where codice=$1', [req.params.codice]); if (!r) throw httpErr(404, 'ruolo inesistente');
    if (r.sistema && r.codice !== 'organizzazione') throw httpErr(400, 'i ruoli di base (giudice, giudice master, partecipante) non si modificano');
    const aree = req.body?.aree === undefined ? r.aree : areeValide(req.body.aree);
    const nome = r.sistema ? r.nome : (String(req.body?.nome || r.nome).trim().slice(0, 60) || r.nome);
    return (await pool.query('update ruolo set nome=$2, aree=$3 where codice=$1 returning codice, nome, sistema, aree', [r.codice, nome, aree])).rows[0];
  });
  app.delete('/api/ruoli/:codice', { preHandler: soloAdmin }, async (req) => {
    const { rows: [r] } = await pool.query('select * from ruolo where codice=$1', [req.params.codice]); if (!r) throw httpErr(404, 'ruolo inesistente');
    if (r.sistema) throw httpErr(400, 'i ruoli di base non si eliminano');
    const { rows: [{ n }] } = await pool.query('select count(*)::int n from utente where ruolo=$1', [r.codice]);
    if (n) throw httpErr(409, `${n} utenti hanno questo ruolo: cambialo prima`);
    await pool.query('delete from ruolo where codice=$1', [r.codice]); return { ok: true };
  });

  const nomeCognome = (nome, cognome) => {
    nome = String(nome || '').trim(); cognome = String(cognome || '').trim();
    if (!cognome) { const i = nome.lastIndexOf(' '); if (i > 0) { cognome = nome.slice(i + 1); nome = nome.slice(0, i); } else cognome = nome; }
    return { nome, cognome };
  };
  const ruoloEsiste = async (db, r) => (await db.query('select 1 from ruolo where codice=$1', [r])).rowCount > 0;
  app.get('/api/utenti', { preHandler: soloAdmin }, async () =>
    (await pool.query(`select id, email, nome, ruolo, admin, ruolo_gara, attivo, evento_id, mfa_attiva,
        (select id from partecipante p where p.utente_id = utente.id) as persona_id,
        (select coalesce(array_agg(provider), '{}') from utente_identita i where i.utente_id = utente.id) as identita from utente order by nome`)).rows);
  app.post('/api/utenti', { preHandler: soloAdmin }, async (req) => {
    const { email, nome, cognome, ruolo = 'giudice', solo_sso, admin = false } = req.body || {};
    const password = solo_sso ? crypto.randomBytes(24).toString('base64url') : req.body?.password;   // solo accesso con Google/Microsoft: password casuale mai comunicata
    if (!email || !nome || !password || password.length < 8) throw httpErr(400, 'email, nome e password (min. 8 caratteri) obbligatori');
    if (!(await ruoloEsiste(pool, ruolo))) throw httpErr(400, 'ruolo non valido');
    const nc = nomeCognome(nome, cognome);
    try {
      return await inTransazione(pool, async (db) => {
        const u = (await db.query('insert into utente (email, nome, ruolo, admin, password_hash) values ($1,$2,$3,$4,$5) returning id, email, nome, ruolo, admin, attivo',
          [email.trim(), `${nc.nome} ${nc.cognome}`.trim(), ruolo, !!admin, hashPassword(password)])).rows[0];
        // ogni utente è anche in anagrafica: se la persona c'è già (stessa email) la si collega, altrimenti si crea
        const { rowCount } = await db.query('update partecipante set utente_id=$1 where id = (select id from partecipante where lower(email)=lower($2) and utente_id is null order by created_at limit 1)', [u.id, email.trim()]);
        if (!rowCount) await db.query('insert into partecipante (cognome, nome, email, utente_id) values ($1,$2,$3,$4)', [nc.cognome, nc.nome, email.trim(), u.id]);
        return u;
      });
    } catch (e) { if (e.code === '23505') throw httpErr(409, 'email già registrata'); throw e; }
  });
  app.patch('/api/utenti/:id', { preHandler: soloAdmin }, async (req) => {
    const b = req.body || {};
    if (req.params.id === req.utente.id && (b.attivo === false || b.admin === false)) throw httpErr(400, 'non puoi disattivare o togliere l\'admin a te stesso');
    if (b.ruolo && !(await ruoloEsiste(pool, b.ruolo))) throw httpErr(400, 'ruolo non valido');
    if (b.password && b.password.length < 8) throw httpErr(400, 'password: minimo 8 caratteri');
    const { rows: [u] } = await pool.query(
      `update utente set nome=coalesce($2,nome), ruolo=coalesce($3,ruolo), attivo=coalesce($4,attivo),
         password_hash=coalesce($5,password_hash), admin=coalesce($8,admin),
         evento_id = case when $6 then $7::uuid else evento_id end where id=$1 returning id, email, nome, ruolo, admin, attivo, evento_id`,
      [req.params.id, b.nome ?? null, b.ruolo ?? null, b.attivo ?? null, b.password ? hashPassword(b.password) : null,
       'evento_id' in b, b.evento_id || null, typeof b.admin === 'boolean' ? b.admin : null]);
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
    const cf = testo(b.codice_fiscale)?.toUpperCase().replace(/\s/g, '') ?? null;
    if (cf) { const v = verificaCodiceFiscale(cf); if (!v.ok) throw httpErr(400, v.errore); }
    const em = testo(b.email);
    if (em && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw httpErr(400, 'email non valida');
    if (b.data_nascita && !/^\d{4}-\d{2}-\d{2}$/.test(b.data_nascita)) throw httpErr(400, 'data di nascita non valida');
    return { cognome: testo(b.cognome), nome: testo(b.nome), data_nascita: b.data_nascita || null, cf, email: em,
             comitato: testo(b.comitato), provincia: testo(b.provincia)?.toUpperCase() ?? null, note: testo(b.note) };
  };
  const COL_PERSONA = `p.id, p.cognome, p.nome, to_char(p.data_nascita,'YYYY-MM-DD') as data_nascita, p.cf_cifrato, p.email, p.comitato, p.provincia, p.note, p.ruolo_gara, p.utente_id,
    (select r.nome from utente u join ruolo r on r.codice = u.ruolo where u.id = p.utente_id) as ruolo_utente, (select u.admin from utente u where u.id = p.utente_id) as admin_utente`;
  // il codice fiscale in chiaro lo vede solo l'admin; gli altri sanno solo se c'è
  const uscita = (req) => ({ cf_cifrato, ...r }) => ({ ...r, ha_cf: !!cf_cifrato, codice_fiscale: req.utente.ruolo === 'admin' && cf_cifrato ? decifra(cf_cifrato) : undefined });
  const duplicato = (e) => { if (e.code === '23505') throw httpErr(409, 'codice fiscale già presente in anagrafica'); throw e; };
  app.get('/api/persone', { preHandler: soloOrg }, async (req) => {
    const q = testo(req.query.q); const qcf = q && /^[A-Za-z0-9]{16}$/.test(q) ? hashCf(q) : null;
    return (await pool.query(
      `select ${COL_PERSONA}, (select count(*) from squadra_membro m where m.partecipante_id = p.id)::int as squadre
         from partecipante p
        where $1::text is null or p.cognome ilike '%'||$1||'%' or p.nome ilike '%'||$1||'%' or p.comitato ilike '%'||$1||'%' or p.email ilike '%'||$1||'%' or p.cf_hash = $2
        order by p.cognome, p.nome limit 500`, [q, qcf])).rows.map(uscita(req));
  });
  app.post('/api/persone', { preHandler: soloOrg }, async (req) => {
    const p = persona(req.body || {});
    if (!p.cognome || !p.nome) throw httpErr(400, 'cognome e nome obbligatori');
    const cf = datiCf(p.cf);                                                     // si può scrivere da chi gestisce l'anagrafica, ma lo legge solo l'admin
    try {
      const { rows: [r] } = await pool.query(
        `insert into partecipante (cognome, nome, data_nascita, cf_cifrato, cf_hash, email, comitato, provincia, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [p.cognome, p.nome, p.data_nascita, cf.cf_cifrato, cf.cf_hash, p.email, p.comitato, p.provincia, p.note]);
      return (await pool.query(`select ${COL_PERSONA} from partecipante p where p.id=$1`, [r.id])).rows.map(uscita(req))[0];
    } catch (e) { return duplicato(e); }
  });
  app.patch('/api/persone/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, p = persona(b);
    if (!p.cognome || !p.nome) throw httpErr(400, 'cognome e nome obbligatori');
    const tocca = 'codice_fiscale' in b;                                         // se il campo non c'è (chi non è admin non lo vede) resta com'è
    const cf = tocca ? datiCf(p.cf) : null;
    try {
      const { rowCount } = await pool.query(
        `update partecipante set cognome=$2, nome=$3, data_nascita=$4, email=$5, comitato=$6, provincia=$7, note=$8,
           cf_cifrato = case when $9 then $10 else cf_cifrato end, cf_hash = case when $9 then $11 else cf_hash end where id=$1`,
        [req.params.id, p.cognome, p.nome, p.data_nascita, p.email, p.comitato, p.provincia, p.note, tocca, cf?.cf_cifrato ?? null, cf?.cf_hash ?? null]);
      if (!rowCount) throw httpErr(404, 'persona inesistente');
    } catch (e) { if (e.statusCode) throw e; return duplicato(e); }
    return (await pool.query(`select ${COL_PERSONA} from partecipante p where p.id=$1`, [req.params.id])).rows.map(uscita(req))[0];
  });
  app.delete('/api/persone/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [x] } = await pool.query('select utente_id from partecipante where id=$1', [req.params.id]);
    if (x?.utente_id) throw httpErr(409, 'la persona ha un accesso al sito: disattiva prima l\'utente');
    try { await pool.query('delete from partecipante where id=$1', [req.params.id]); }
    catch (e) { if (e.code === '23503') throw httpErr(409, 'la persona fa parte di una squadra o è iscritta a una gara: toglila prima'); throw e; }
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
    if (b.tipo && !['gara', 'olimpiadi', 'allenamento', 'corso', 'esame'].includes(b.tipo)) throw httpErr(400, 'tipo di evento non valido');
    if (b.soglia_pct != null && b.soglia_pct !== '' && !(Number(b.soglia_pct) >= 1 && Number(b.soglia_pct) <= 100)) throw httpErr(400, 'soglia: percentuale tra 1 e 100');
    if (b.mappa_url && !/^https:\/\/(www\.)?google\.com\/maps\//.test(b.mappa_url.trim())) throw httpErr(400, 'la mappa deve essere un indirizzo https://www.google.com/maps/… (Condividi → Incorpora mappa)');
    const { rows: [e] } = await pool.query(
      `update evento set mappa_url = case when $9 then nullif(trim($10),'') else mappa_url end, codice=coalesce($8,codice), nome=coalesce($2,nome), titolo_stampa=coalesce($3,titolo_stampa), luogo=coalesce($4,luogo),
         data=coalesce($5::date,data), tipo=coalesce($6,tipo), soglia_pct = case when $11 then $12::numeric else soglia_pct end, mostra_punteggi = coalesce($13::boolean, mostra_punteggi), archiviato=coalesce($7,archiviato), attivo = case when coalesce($7,archiviato) then false else attivo end, updated_at=now()
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.titolo_stampa ?? null, b.luogo ?? null, b.data ?? null, b.tipo ?? null, b.archiviato ?? null, b.codice?.trim() || null, 'mappa_url' in b, b.mappa_url ?? '', 'soglia_pct' in b, b.soglia_pct === '' ? null : (b.soglia_pct ?? null), b.mostra_punteggi ?? null]);
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
    await controllaScheda(pool, req.utente, req.params.id, { modifica: true });
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
    await controllaScheda(pool, req.utente, req.params.id, { modifica: true });
    try { await pool.query('delete from patologia where id=$1', [req.params.id]); }
    catch (e) { if (e.code === '23503') throw httpErr(409, 'patologia usata in una scena: non eliminabile'); throw e; }
    return { ok: true };
  });
}
