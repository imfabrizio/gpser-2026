import { notifica } from './notifiche.js';
import { canonico } from './comitati.js';
import { profiloFormativo, puoGestireEvento, soloFormazione, TIPI_CORSO } from './ambito.js';
import crypto from 'node:crypto';
// Rotte usate dall'interfaccia di gestione (web/admin.html).
import { hashPassword } from './auth.js';
import { inTransazione } from './db.js';
import { httpErr } from './services/compilazioni.js';
import { AREE } from './permessi.js';
import { controllaScheda, tipologieValide } from './libreria-ambito.js';
import { decifra } from './mfa.js';
import { verificaCodiceFiscale } from './codice-fiscale.js';
import { datiCf, hashCf } from './anagrafica.js';

// ruoli che possono valutare nei corsi e nei Mega Code
const VALUTATORI_CORSI = ['monitore', 'capo_monitore', 'formatore_ms', 'formatore_tssa', 'trainer_ms', 'trainer_tssa', 'istruttore_du', 'admin', 'organizzazione'];
// i Mega Code sono TSSA: vi valutano solo trainer e formatori TSSA (oltre all'organizzazione)
const VALUTATORI_MEGACODE = ['trainer_tssa', 'formatore_tssa', 'admin', 'organizzazione'];
// le qualifiche che hanno un ruolo con lo stesso codice (formazione, simulatore, truccatore) danno il ruolo all'accesso della persona, come ruolo aggiuntivo
async function sincronizzaRuoliQualifiche(db, partecipanteId) {
  const { rows: [p] } = await db.query('select p.utente_id, u.ruolo from partecipante p join utente u on u.id = p.utente_id where p.id=$1', [partecipanteId]);
  if (!p) return;
  const { rows: legate } = await db.query('select r.codice from ruolo r join qualifica q on q.codice = r.codice');
  const { rows: ha } = await db.query('select qualifica from persona_qualifica where partecipante_id=$1', [partecipanteId]);
  const hanno = new Set(ha.map((x) => x.qualifica)), codici = legate.map((x) => x.codice);
  await db.query('delete from utente_ruolo_extra where utente_id=$1 and ruolo = any($2::text[]) and not (ruolo = any($3::text[]))', [p.utente_id, codici, [...hanno]]);
  for (const c of hanno) if (codici.includes(c) && c !== p.ruolo) await db.query('insert into utente_ruolo_extra values ($1,$2) on conflict do nothing', [p.utente_id, c]);
}


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
  app.get('/api/giudici', { preHandler: soloOrg }, async (req) => {
    const q = req.query?.valutatori, lista = !q ? ['giudice', 'giudice_master'] : q === 'megacode' ? VALUTATORI_MEGACODE : [...VALUTATORI_CORSI, 'giudice', 'giudice_master'], elenco = lista.map((x) => `'${x}'`).join(',');   // nei corsi valutano gli istruttori/formatori
    return (await pool.query(`select * from (select id, nome, email, ruolo,
        array_cat(array_prepend(ruolo, coalesce((select array_agg(x.ruolo) from utente_ruolo_extra x where x.utente_id=u.id), '{}')), (select coalesce(array_agg(distinct i.ruolo), '{}') from iscrizione i join partecipante pp on pp.id = i.partecipante_id join evento ee on ee.id = i.evento_id where pp.utente_id = u.id and not ee.archiviato and i.ruolo in (${elenco}))) as ruoli
        from utente u where attivo) q where ruoli && array[${elenco}] or id in (select utente_id from evento_invito where evento_id = $1 and stato = 'attivo') order by nome`, [/^[0-9a-f-]{36}$/i.test(req.query?.corso || '') ? req.query.corso : null])).rows;   // i trainer e formatori del corso valutano i suoi Mega Code
  });

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
    const { rows: [evs] } = await db.query(`select e.tipo, coalesce(e.corso_id, e.id) as corso from scena_scheda s join scena sc on sc.id=s.scena_id join evento e on e.id=sc.evento_id where s.id=$1`, [req.params.id]); const tipoEv = evs?.tipo, megacode = tipoEv === 'megacode';
    const ammessi = megacode ? VALUTATORI_MEGACODE : ['corso', 'esame'].includes(tipoEv) ? ['giudice', 'giudice_master', ...VALUTATORI_CORSI] : ['giudice', 'giudice_master'];
    const { rows: ok } = await db.query(`select id from utente u where id = any($1::uuid[]) and attivo and (exists (select 1 from evento_invito ei where ei.utente_id=u.id and ei.stato='attivo' and ei.evento_id=$4) or ruolo = any($2::text[]) or exists (select 1 from utente_ruolo_extra x where x.utente_id=u.id and x.ruolo = any($2::text[])) or cardinality((select coalesce(array_agg(distinct i.ruolo), '{}') from iscrizione i join partecipante pp on pp.id = i.partecipante_id join evento ee on ee.id = i.evento_id where pp.utente_id = u.id and not ee.archiviato and i.ruolo = any($2::text[]) and not $3)) > 0)`, [ids, ammessi, megacode, evs?.corso ?? null]);
    if (ok.length !== new Set(ids).size) throw httpErr(400, megacode ? 'nei Mega Code valutano solo trainer e formatori TSSA (oltre all\'organizzazione)' : 'solo utenti attivi con ruolo giudice, giudice master o di formazione');
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
    const { rows: ok } = await db.query(`select id from utente u where id = any($1::uuid[]) and attivo and (ruolo='giudice_master' or exists (select 1 from utente_ruolo_extra x where x.utente_id=u.id and x.ruolo='giudice_master') or exists (select 1 from iscrizione i join partecipante pp on pp.id = i.partecipante_id join evento ee on ee.id = i.evento_id where pp.utente_id = u.id and not ee.archiviato and i.ruolo = 'giudice_master'))`, [ids]);
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
             comitato: testo(b.comitato), provincia: testo(b.provincia)?.toUpperCase() ?? null, unita: testo(b.unita), note: testo(b.note) };
  };
  // comitato scritto in modo libero → nome ufficiale; provincia e unità territoriale si completano da sole (unità = il comitato stesso se non ne ha)
  const ufficiale = async (p) => {
    const { nome, comitato } = await canonico(pool, p.comitato); p.comitato = nome;
    if (comitato) { p.provincia ??= comitato.provincia?.toUpperCase() ?? null; const u = comitato.unita.length ? comitato.unita : [comitato.nome]; p.unita = u.find((x) => x.toLowerCase() === (p.unita || '').toLowerCase()) ?? (u.length === 1 ? u[0] : p.unita); }
  };
  const COL_PERSONA = `p.id, p.cognome, p.nome, to_char(p.data_nascita,'YYYY-MM-DD') as data_nascita, p.cf_cifrato, p.email, p.comitato, p.provincia, p.unita, p.note, p.ruolo_gara, p.utente_id,
    (select r.nome from utente u join ruolo r on r.codice = u.ruolo where u.id = p.utente_id) as ruolo_utente, (select u.ruolo from utente u where u.id = p.utente_id) as ruolo_codice, (select coalesce(array_agg(x.ruolo), '{}') from utente_ruolo_extra x where x.utente_id = p.utente_id) as ruoli_extra, (select u.per_evento from utente u where u.id = p.utente_id) as per_evento, (select u.attivo from utente u where u.id = p.utente_id) as accesso_attivo, (select u.evento_id from utente u where u.id = p.utente_id) as accesso_evento, (select u.mfa_attiva from utente u where u.id = p.utente_id) as accesso_mfa, (select coalesce(array_agg(q.qualifica order by q.qualifica), '{}') from persona_qualifica q where q.partecipante_id = p.id) as qualifiche, (select u.admin from utente u where u.id = p.utente_id) as admin_utente`;
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
    await ufficiale(p);
    const cf = datiCf(p.cf);                                                     // si può scrivere da chi gestisce l'anagrafica, ma lo legge solo l'admin
    try {
      const { rows: [r] } = await pool.query(
        `insert into partecipante (cognome, nome, data_nascita, cf_cifrato, cf_hash, email, comitato, provincia, note, unita)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [p.cognome, p.nome, p.data_nascita, cf.cf_cifrato, cf.cf_hash, p.email, p.comitato, p.provincia, p.note, p.unita]);
      return (await pool.query(`select ${COL_PERSONA} from partecipante p where p.id=$1`, [r.id])).rows.map(uscita(req))[0];
    } catch (e) { return duplicato(e); }
  });
  app.patch('/api/persone/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, p = persona(b);
    if (!p.cognome || !p.nome) throw httpErr(400, 'cognome e nome obbligatori');
    await ufficiale(p);
    const tocca = 'codice_fiscale' in b;                                         // se il campo non c'è (chi non è admin non lo vede) resta com'è
    const cf = tocca ? datiCf(p.cf) : null;
    try {
      const { rowCount } = await pool.query(
        `update partecipante set cognome=$2, nome=$3, data_nascita=$4, email=$5, comitato=$6, provincia=$7, note=$8, unita=$12,
           cf_cifrato = case when $9 then $10 else cf_cifrato end, cf_hash = case when $9 then $11 else cf_hash end where id=$1`,
        [req.params.id, p.cognome, p.nome, p.data_nascita, p.email, p.comitato, p.provincia, p.note, tocca, cf?.cf_cifrato ?? null, cf?.cf_hash ?? null, p.unita]);
      if (!rowCount) throw httpErr(404, 'persona inesistente');
    } catch (e) { if (e.statusCode) throw e; return duplicato(e); }
    return (await pool.query(`select ${COL_PERSONA} from partecipante p where p.id=$1`, [req.params.id])).rows.map(uscita(req))[0];
  });
  app.get('/api/qualifiche', { preHandler: soloOrg }, async () => (await pool.query('select codice, nome, ambito, sistema, (select count(*)::int from persona_qualifica p where p.qualifica = q.codice) as persone from qualifica q order by nome')).rows);
  app.post('/api/qualifiche', { preHandler: soloAdmin }, async (req) => {
    const nome = String(req.body?.nome || '').trim().slice(0, 60), codice = slug(nome), ambito = req.body?.ambito || null;
    if (!codice) throw httpErr(400, 'nome della qualifica obbligatorio');
    if (ambito && !['locale', 'nazionale'].includes(ambito)) throw httpErr(400, 'ambito non valido');
    try { return (await pool.query('insert into qualifica (codice, nome, ambito) values ($1,$2,$3) returning codice, nome, ambito, sistema', [codice, nome, ambito])).rows[0]; }
    catch (e) { if (e.code === '23505') throw httpErr(409, 'esiste già una qualifica con questo nome'); throw e; }
  });
  app.delete('/api/qualifiche/:codice', { preHandler: soloAdmin }, async (req) => {
    const { rows: [q] } = await pool.query('select sistema from qualifica where codice=$1', [req.params.codice]);
    if (!q) throw httpErr(404, 'qualifica inesistente'); if (q.sistema) throw httpErr(400, 'le qualifiche di base non si eliminano');
    try { await pool.query('delete from qualifica where codice=$1', [req.params.codice]); } catch (e) { if (e.code === '23503') throw httpErr(409, 'qualifica assegnata a delle persone: toglila prima'); throw e; }
    return { ok: true };
  });
  app.put('/api/persone/:id/qualifiche', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const q = req.body?.qualifiche;
    if (!Array.isArray(q) || q.some((x) => typeof x !== 'string') || (await db.query('select 1 from qualifica where codice = any($1::text[])', [q])).rowCount === 0 && q.length) throw httpErr(400, 'qualifiche non valide');
    { const { rows: v } = await db.query('select codice from qualifica where codice = any($1::text[])', [q]); if (v.length !== new Set(q).size) throw httpErr(400, 'qualifiche non valide'); }
    if (!(await db.query('select 1 from partecipante where id=$1', [req.params.id])).rowCount) throw httpErr(404, 'persona inesistente');
    await db.query('delete from persona_qualifica where partecipante_id=$1', [req.params.id]);
    for (const x of new Set(q)) await db.query('insert into persona_qualifica values ($1,$2)', [req.params.id, x]);
    await sincronizzaRuoliQualifiche(db, req.params.id);
    return { ok: true, qualifiche: [...new Set(q)] };
  }));
  // assegna il ruolo direttamente dall'anagrafica: se la persona non ha ancora un accesso lo crea (solo Google/Microsoft, collegato all'email), altrimenti cambia il ruolo
  app.post('/api/persone/:id/accesso', { preHandler: soloAdmin }, async (req) => {
    const { ruolo, admin, extra, per_evento } = req.body || {};
    if (!ruolo || !(await ruoloEsiste(pool, ruolo))) throw httpErr(400, 'ruolo non valido');
    return inTransazione(pool, async (db) => {
      const { rows: [p] } = await db.query('select id, cognome, nome, email, utente_id from partecipante where id=$1', [req.params.id]);
      if (!p) throw httpErr(404, 'persona inesistente');
      let uid = p.utente_id;
      if (!uid) {
        const email = (p.email || '').trim();
        if (!email) throw httpErr(400, 'serve l\'email della persona: scrivila in anagrafica, sarà il suo login');
        const { rows: [esiste] } = await db.query('select id from utente where lower(email)=lower($1)', [email]);
        if (esiste) { uid = esiste.id; await db.query('update partecipante set utente_id=$1 where id=$2', [uid, p.id]); }
        else {
          uid = (await db.query('insert into utente (email, nome, ruolo, admin, password_hash) values ($1,$2,$3,$4,$5) returning id',
            [email, `${p.nome} ${p.cognome}`.trim(), ruolo, !!admin, hashPassword(crypto.randomBytes(24).toString('base64url'))])).rows[0].id;
          await db.query('update partecipante set utente_id=$1 where id=$2', [uid, p.id]);
        }
      }
      if (uid === req.utente.id && admin === false) throw httpErr(400, 'non puoi togliere l\'admin a te stesso');
      await db.query('update utente set ruolo=$2, admin=coalesce($3,admin), per_evento=coalesce($4,per_evento) where id=$1', [uid, ruolo, typeof admin === 'boolean' ? admin : null, typeof per_evento === 'boolean' ? per_evento : null]);
      if (Array.isArray(extra)) {                                                  // ruoli aggiuntivi: una persona può essere, per esempio, giudice master e organizzazione
        const el = [...new Set(extra.filter((x) => typeof x === 'string' && x !== ruolo))];
        const { rows: v } = await db.query('select codice from ruolo where codice = any($1::text[])', [el]);
        if (v.length !== el.length) throw httpErr(400, 'ruolo aggiuntivo non valido');
        await db.query('delete from utente_ruolo_extra where utente_id=$1', [uid]);
        for (const r of el) await db.query('insert into utente_ruolo_extra values ($1,$2)', [uid, r]);
      }
      await sincronizzaRuoliQualifiche(db, p.id);
      return { ok: true, utente_id: uid };
    });
  });
  // elimina la persona e, se ce l'ha, anche l'accesso al sito: le valutazioni già registrate restano, senza il collegamento all'utente
  app.delete('/api/persone/:id', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const { rows: [x] } = await db.query('select p.utente_id, u.admin from partecipante p left join utente u on u.id=p.utente_id where p.id=$1 for update of p', [req.params.id]);
    if (!x) throw httpErr(404, 'persona inesistente');
    if (x.utente_id) {
      if (x.utente_id === req.utente.id) throw httpErr(409, 'non puoi eliminare te stesso');
      if (x.admin && !req.utente.admin) throw httpErr(403, 'un amministratore lo elimina solo un altro amministratore');
      if (x.admin && (await db.query('select count(*)::int as n from utente where admin and attivo and id <> $1', [x.utente_id])).rows[0].n === 0) throw httpErr(409, 'è l\'ultimo amministratore');
    }
    try { await db.query('savepoint sp_p'); await db.query('delete from partecipante where id=$1', [req.params.id]); await db.query('release savepoint sp_p'); }
    catch (e) { if (e.code === '23503') throw httpErr(409, 'la persona fa parte di una squadra o è iscritta a una gara: toglila prima'); throw e; }
    if (x.utente_id) {
      const { rows: fk } = await db.query(
        `select c.conrelid::regclass::text as tabella, a.attname as colonna, a.attnotnull as obbligatoria from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
          where c.contype='f' and c.confrelid='utente'::regclass and c.confdeltype='a'`);
      for (const f of fk) {
        if (f.obbligatoria) { const r = await db.query(`select 1 from ${f.tabella} where ${f.colonna}=$1 limit 1`, [x.utente_id]); if (r.rowCount) throw httpErr(409, `l'accesso è usato in ${f.tabella.replace(/_/g, ' ')}: non eliminabile`); }
        else await db.query(`update ${f.tabella} set ${f.colonna}=null where ${f.colonna}=$1`, [x.utente_id]);
      }
      await db.query('delete from utente where id=$1', [x.utente_id]);
    }
    return { ok: true };
  }));
  // ── discenti di un corso: con loro si compongono gli equipaggi dei Mega Code del corso ──
  const corsoDi = async (req) => {
    const e = await (async () => { const { rows: [x] } = await pool.query('select id, tipo, comitato, corso_id from evento where id=$1', [req.params.id]); if (!x) throw httpErr(404, 'evento inesistente'); if (!(await puoGestireEvento(pool, req.utente, x))) throw httpErr(403, 'evento fuori dal tuo ambito'); return x; })();
    return e.tipo === 'corso' ? e.id : (e.corso_id || null);
  };
  app.get('/api/eventi/:id/discenti', { preHandler: soloOrg }, async (req) => {
    const corso = await corsoDi(req); if (!corso) return { corso_id: null, discenti: [] };
    return { corso_id: corso, discenti: (await pool.query(
      `select i.id as iscrizione_id, p.id as partecipante_id, p.cognome, p.nome, p.comitato, p.provincia,
         (select coalesce(array_agg(q.qualifica order by q.qualifica), '{}') from persona_qualifica q where q.partecipante_id = p.id) as qualifiche
       from iscrizione i join partecipante p on p.id = i.partecipante_id where i.evento_id=$1 and i.ruolo='discente' order by p.cognome, p.nome`, [corso])).rows };
  });
  app.post('/api/eventi/:id/discenti', { preHandler: soloOrg }, async (req) => {
    const corso = await corsoDi(req); if (!corso || corso !== req.params.id) throw httpErr(400, 'i discenti si aggiungono al corso');
    const ids = [].concat(req.body?.partecipanti ?? req.body?.partecipante_id ?? []);
    if (!ids.length || ids.length > 100) throw httpErr(400, 'indica da 1 a 100 persone');
    const { rows: ok } = await pool.query('select id from partecipante where id = any($1::uuid[])', [ids]);
    if (ok.length !== new Set(ids).size) throw httpErr(400, 'persona inesistente');
    for (const id of new Set(ids)) await pool.query(`insert into iscrizione (evento_id, partecipante_id, ruolo) values ($1,$2,'discente') on conflict (evento_id, partecipante_id) do update set ruolo = 'discente' where iscrizione.ruolo = 'discente'`, [corso, id]);
    return { ok: true };
  });
  app.delete('/api/eventi/:id/discenti/:pid', { preHandler: soloOrg }, async (req) => {
    const corso = await corsoDi(req); if (!corso || corso !== req.params.id) throw httpErr(400, 'i discenti si tolgono dal corso');
    await pool.query(`delete from squadra_membro where partecipante_id=$2 and squadra_id in (select s.id from squadra s join evento e on e.id=s.evento_id where e.corso_id=$1)`, [corso, req.params.pid]);
    await pool.query(`delete from iscrizione where evento_id=$1 and partecipante_id=$2 and ruolo='discente'`, [corso, req.params.pid]);
    return { ok: true };
  });
  app.get('/api/squadre/:id/membri', { preHandler: soloOrg }, async (req) => (await pool.query(
    `select m.partecipante_id, m.ruolo, p.cognome, p.nome, p.comitato, p.provincia, (select coalesce(array_agg(q.qualifica order by q.qualifica), '{}') from persona_qualifica q where q.partecipante_id = p.id) as qualifiche from squadra_membro m
       join partecipante p on p.id = m.partecipante_id where m.squadra_id=$1 order by p.cognome, p.nome`, [req.params.id])).rows);
  app.put('/api/squadre/:id/membri', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const lista = req.body?.membri;
    if (!Array.isArray(lista) || lista.length > 50) throw httpErr(400, 'membri: elenco (max 50)');
    const ids = lista.map((m) => m?.partecipante_id);
    if (new Set(ids).size !== ids.length) throw httpErr(400, 'persona ripetuta');
    const { rows: [sq] } = await db.query('select e.tipo, e.corso_id from squadra s join evento e on e.id=s.evento_id where s.id=$1', [req.params.id]);
    if (!sq) throw httpErr(404, 'squadra inesistente');
    if (sq.tipo === 'megacode' && sq.corso_id) {                                    // l'equipaggio di un Mega Code si compone dai discenti del suo corso
      const { rows: d } = await db.query(`select partecipante_id from iscrizione where evento_id=$1 and ruolo='discente' and partecipante_id = any($2::uuid[])`, [sq.corso_id, ids]);
      if (d.length !== ids.length) throw httpErr(400, 'nell\'equipaggio di un Mega Code possono esserci solo i discenti del corso');
    }
    const { rows: ok } = await db.query('select id from partecipante where id = any($1::uuid[])', [ids]);
    if (ok.length !== ids.length) throw httpErr(400, 'persona inesistente');
    await db.query('delete from squadra_membro where squadra_id=$1', [req.params.id]);
    for (const m of lista) await db.query('insert into squadra_membro values ($1,$2,$3)', [req.params.id, m.partecipante_id, testo(m.ruolo)]);
    return { ok: true, membri: lista.length };
  }));

  // ── evento / scena / scheda ──
  app.patch('/api/eventi/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (b.tipo && !['gara', 'olimpiadi', 'allenamento', 'corso', 'esame', 'megacode', 'corso_giudici'].includes(b.tipo)) throw httpErr(400, 'tipo di evento non valido');
    const { rows: [att] } = await pool.query('select id, tipo, comitato, corso_id from evento where id=$1', [req.params.id]);
    if (!att) throw httpErr(404, 'evento inesistente');
    { const tipoFin = b.tipo ?? att.tipo, corsoFin = 'corso_id' in b ? (b.corso_id || null) : att.corso_id;
      if (tipoFin === 'megacode' && (b.tipo === 'megacode' || 'corso_id' in b)) {
        const { rows: [c] } = await pool.query('select tipo, archiviato from evento where id=$1', [corsoFin]);
        if (!c || c.tipo !== 'corso' || c.archiviato) throw httpErr(400, 'il Mega Code va assegnato a un corso attivo'); } }
    const prof = soloFormazione(req.utente) ? await profiloFormativo(pool, req.utente.id) : null;
    if (!(await puoGestireEvento(pool, req.utente, att, prof))) throw httpErr(403, 'evento fuori dal tuo ambito');
    if (prof && b.tipo && !TIPI_CORSO.includes(b.tipo)) throw httpErr(403, 'tipo di evento non consentito');
    const cambiaCom = 'comitato' in b && (!prof || prof.nazionale);                      // il comitato organizzatore lo cambia solo chi ha ambito nazionale (o la gestione gare)
    const comitatoNuovo = cambiaCom && b.comitato ? (await canonico(pool, String(b.comitato))).nome : null;
    if (b.soglia_pct != null && b.soglia_pct !== '' && !(Number(b.soglia_pct) >= 1 && Number(b.soglia_pct) <= 100)) throw httpErr(400, 'soglia: percentuale tra 1 e 100');
    if (b.mappa_url && !/^https:\/\/(www\.)?google\.com\/maps\//.test(b.mappa_url.trim())) throw httpErr(400, 'la mappa deve essere un indirizzo https://www.google.com/maps/… (Condividi → Incorpora mappa)');
    const { rows: [e] } = await pool.query(
      `update evento set mappa_url = case when $9 then nullif(trim($10),'') else mappa_url end, codice=coalesce($8,codice), nome=coalesce($2,nome), titolo_stampa=coalesce($3,titolo_stampa), luogo=coalesce($4,luogo),
         data=coalesce($5::date,data), tipo=coalesce($6,tipo), soglia_pct = case when $11 then $12::numeric else soglia_pct end, mostra_punteggi = coalesce($13::boolean, mostra_punteggi), codice_gaia = case when $14 then nullif(trim($15),'') else codice_gaia end, corso_id = case when $16 then $17::uuid else corso_id end, comitato = case when $18 then $19 else comitato end, archiviato=coalesce($7,archiviato), attivo = case when coalesce($7,archiviato) then false else attivo end, updated_at=now()
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.titolo_stampa ?? null, b.luogo ?? null, b.data ?? null, b.tipo ?? null, b.archiviato ?? null, b.codice?.trim() || null, 'mappa_url' in b, b.mappa_url ?? '', 'soglia_pct' in b, b.soglia_pct === '' ? null : (b.soglia_pct ?? null), b.mostra_punteggi ?? null,
       'codice_gaia' in b, b.codice_gaia ?? '', 'corso_id' in b, b.corso_id || null, cambiaCom, comitatoNuovo]);
    if (!e) throw httpErr(404, 'evento inesistente');
    return e;
  });
  // inviti: un trainer di un altro comitato viene invitato al singolo evento e lo gestisce solo per quello
  const gestisce = async (req) => { const { rows: [e] } = await pool.query('select id, tipo, comitato, corso_id from evento where id=$1', [req.params.id]); if (!e) throw httpErr(404, 'evento inesistente'); if (!(await puoGestireEvento(pool, req.utente, e))) throw httpErr(403, 'evento fuori dal tuo ambito'); return e; };
  const normCom = (c) => String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  app.get('/api/eventi/:id/inviti', { preHandler: soloOrg }, async (req) => { await gestisce(req);
    return (await pool.query(`select i.utente_id, i.stato, u.nome, u.email, (select p.comitato from partecipante p where p.utente_id=u.id) as comitato,
        (select string_agg(q.nome, ', ' order by q.nome) from partecipante p join persona_qualifica pq on pq.partecipante_id=p.id join qualifica q on q.codice=pq.qualifica where p.utente_id=u.id and q.ambito is not null) as qualifiche
      from evento_invito i join utente u on u.id=i.utente_id where i.evento_id=$1 order by (i.stato='attivo') desc, u.nome`, [req.params.id])).rows; });
  // chi si può aggiungere: persone con accesso e qualifica da trainer/formatore; i colleghi del comitato del corso si attivano subito, gli altri ricevono una richiesta
  app.get('/api/eventi/:id/invitabili', { preHandler: soloOrg }, async (req) => { const e = await gestisce(req);
    const { rows: [ev] } = await pool.query('select comitato from evento where id=$1', [e.id]);
    const rows = (await pool.query(`select p.id, p.cognome, p.nome, p.comitato,
          (select string_agg(q.nome, ', ' order by q.nome) from persona_qualifica pq join qualifica q on q.codice=pq.qualifica where pq.partecipante_id=p.id and q.ambito is not null) as qualifiche
        from partecipante p
        where p.utente_id is not null and exists (select 1 from persona_qualifica pq join qualifica q on q.codice=pq.qualifica where pq.partecipante_id=p.id and q.ambito is not null)
          and p.utente_id not in (select utente_id from evento_invito where evento_id=$1) order by p.comitato nulls last, p.cognome, p.nome`, [req.params.id])).rows;
    return rows.map((r) => ({ ...r, stesso_comitato: !!ev?.comitato && normCom(r.comitato) === normCom(ev.comitato) })); });
  app.post('/api/eventi/:id/inviti', { preHandler: soloOrg }, async (req) => { const e = await gestisce(req);
    const ids = [].concat(req.body?.partecipanti ?? req.body?.partecipante_id ?? []);
    if (!ids.length || ids.length > 100) throw httpErr(400, 'scegli da 1 a 100 persone');
    const { rows: [ev] } = await pool.query('select nome, comitato from evento where id=$1', [e.id]);
    let attivi = 0, richiesti = 0;
    for (const pid of new Set(ids)) {
      const { rows: [p] } = await pool.query('select id, utente_id, comitato from partecipante where id=$1', [pid]);
      if (!p) throw httpErr(404, 'persona inesistente');
      if (!p.utente_id) throw httpErr(400, 'la persona non ha un accesso al sito: crealo prima dall\'anagrafica');
      const { rowCount } = await pool.query('select 1 from persona_qualifica pq join qualifica q on q.codice=pq.qualifica where pq.partecipante_id=$1 and q.ambito is not null', [p.id]);
      if (!rowCount) throw httpErr(400, 'si aggiungono persone con una qualifica di trainer, monitore, formatore o capo monitore');
      const stesso = !!ev.comitato && normCom(p.comitato) === normCom(ev.comitato);
      const stato = stesso || req.utente.ruolo === 'admin' || p.utente_id === req.utente.id ? 'attivo' : 'richiesto';
      const { rowCount: nuovo } = await pool.query('insert into evento_invito (evento_id, utente_id, invitato_da, stato) values ($1,$2,$3,$4) on conflict do nothing', [e.id, p.utente_id, req.utente.id, stato]);
      if (!nuovo) continue;
      if (stato === 'attivo') attivi++; else {
        richiesti++;
        await notifica(pool, p.utente_id, { tipo: 'invito_corso', titolo: `Richiesta di collaborare al corso «${ev.nome}»`, testo: `${req.utente.nome || 'Un organizzatore'} ti chiede di partecipare come trainer / formatore e valutatore. Rispondi dalla pagina delle richieste.`, link: '/#inviti' });
      }
    }
    return { ok: true, attivi, richiesti }; });
  app.delete('/api/eventi/:id/inviti/:utente', { preHandler: soloOrg }, async (req) => { await gestisce(req);
    await pool.query('delete from evento_invito where evento_id=$1 and utente_id=$2', [req.params.id, req.params.utente]); return { ok: true }; });
  // le richieste che ricevo come trainer / formatore e la mia risposta
  app.get('/api/me/inviti', async (req) => (await pool.query(`select i.evento_id, e.nome as corso, e.comitato, to_char(e.data,'YYYY-MM-DD') as data, to_char(e.data_fine,'YYYY-MM-DD') as data_fine, e.luogo, u.nome as da
      from evento_invito i join evento e on e.id=i.evento_id left join utente u on u.id=i.invitato_da where i.utente_id=$1 and i.stato='richiesto' and not e.archiviato order by i.created_at desc`, [req.utente.id])).rows);
  app.post('/api/me/inviti/:evento/:risposta', async (req) => {
    const ok = req.params.risposta === 'accetta';
    if (!ok && req.params.risposta !== 'rifiuta') throw httpErr(404, 'risposta sconosciuta');
    const { rows: [i] } = await pool.query(`update evento_invito set stato=$3 where evento_id=$1 and utente_id=$2 and stato='richiesto' returning invitato_da`, [req.params.evento, req.utente.id, ok ? 'attivo' : 'rifiutato']);
    if (!i) throw httpErr(404, 'nessuna richiesta in attesa per questo corso');
    const { rows: [e] } = await pool.query('select nome from evento where id=$1', [req.params.evento]);
    await notifica(pool, i.invitato_da, { tipo: 'invito_corso', titolo: `${req.utente.nome || 'Il formatore'} ha ${ok ? 'accettato' : 'rifiutato'} di collaborare al corso «${e.nome}»`, link: '/admin.html#corsi' });
    return { ok: true, stato: ok ? 'attivo' : 'rifiutato' };
  });
  app.patch('/api/scene/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [s] } = await pool.query(
      `update scena set titolo=coalesce($2,titolo), ordine=coalesce($3,ordine),
         indirizzo = case when $4 then nullif(trim($5),'') else indirizzo end,
         lat = case when $6 then $7::numeric else lat end, lng = case when $6 then $8::numeric else lng end,
         canovaccio_id = case when $9 then nullif($10,'')::uuid else canovaccio_id end where id=$1 returning *`,
      [req.params.id, b.titolo ?? null, b.ordine ?? null, 'indirizzo' in b, b.indirizzo ?? '',
       'lat' in b || 'lng' in b, b.lat === '' ? null : (b.lat ?? null), b.lng === '' ? null : (b.lng ?? null), 'canovaccio_id' in b, b.canovaccio_id ?? '']);
    if (!s) throw httpErr(404, 'scena inesistente');
    return s;
  });
  app.patch('/api/schede/:id', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [s] } = await pool.query(
      `update scena_scheda set titolo=coalesce($2,titolo), simulatore=coalesce($3,simulatore),
         parametri=coalesce($4::jsonb,parametri), gravita = case when $5 then nullif($6,'') else gravita end where id=$1 returning *`,
      [req.params.id, b.titolo ?? null, b.simulatore ?? null, b.parametri ? JSON.stringify(b.parametri) : null, 'gravita' in b, b.gravita ?? '']);
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
  // eliminazione definitiva di un evento (corso, Mega Code, esame, gara) con tutto ciò che contiene: solo admin; un corso porta con sé i suoi Mega Code ed esami
  app.delete('/api/eventi/:id', { preHandler: soloAdmin }, async (req) => inTransazione(pool, async (db) => {
    const { rows: [e] } = await db.query('select id, tipo from evento where id=$1', [req.params.id]);
    if (!e) throw httpErr(404, 'evento inesistente');
    const ids = (await db.query(`with recursive t as (select id from evento where id=$1 union select f.id from evento f join t on f.corso_id = t.id) select id from t`, [req.params.id])).rows.map((x) => x.id);
    await db.query(`delete from compilazione where scheda_id in (select s.id from scena_scheda s join scena sc on sc.id=s.scena_id where sc.evento_id = any($1::uuid[]))
                      or squadra_id in (select id from squadra where evento_id = any($1::uuid[]))`, [ids]);
    await db.query('delete from scena where evento_id = any($1::uuid[])', [ids]);
    await db.query('delete from evento where id = any($1::uuid[])', [ids]);
    return { ok: true, eliminati: ids.length };
  }));
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
         categoria = case when $7 then nullif(trim($8),'') else categoria end, categoria2 = case when $9 then nullif(trim($10),'') else categoria2 end,
         macro = case when $11 then nullif($12,'') else macro end, macro2 = case when $13 then nullif($14,'') else macro2 end, gravita = case when $15 then nullif($16,'') else gravita end, tipologie = coalesce($17::text[], tipologie)
       where id=$1 returning *`, [req.params.id, b.nome ?? null, b.sigla ?? null, b.is_bls ?? null, b.is_master ?? null, b.is_diu ?? null,
        'categoria' in b, b.categoria ?? '', 'categoria2' in b, b.categoria2 ?? '',
        'macro' in b, b.macro ?? '', 'macro2' in b, b.macro2 ?? '', 'gravita' in b, b.gravita ?? '', 'tipologie' in b ? tipologieValide(b.tipologie) : null]);
    if (!p) throw httpErr(404, 'patologia inesistente');
    if (Array.isArray(b.errori_gravi)) await db.query('update patologia set errori_gravi=$2::text[] where id=$1', [p.id, b.errori_gravi.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 12)]);
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
