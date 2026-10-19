import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { firmaToken, leggiToken, verificaPassword, troppiTentativi, registraFallimento, azzeraFallimenti, verificaPasswordFinta } from './auth.js';
import { inTransazione } from './db.js';
import { sincronizza, riapri, httpErr } from './services/compilazioni.js';
import { generaPdfSchede } from './services/stampa.js';
import { registraGestione } from './routes-gestione.js';
import { aggiungiSchedaDaPatologia, creaScena, duplicaScena } from './services/scene.js';
import { importaExcel } from './services/import-excel.js';

const RUOLI_ORG = ['admin', 'organizzazione'];

export function buildApp(pool, { logger = false } = {}) {
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY === '1' });   // TRUST_PROXY=1 solo dietro a un proxy fidato (es. hosting con HTTPS)
  app.addHook('onError', async (req, reply, err) => { if (process.env.DEBUG_ERR) console.error('ERR', err); });

  // ── sicurezza: intestazioni ──
  app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // controllo di salute (pubblico, senza dati): usato dall'hosting e per tenere sveglio il servizio
  app.get('/salute', async () => { await pool.query('select 1'); return { ok: true }; });

  // ── autenticazione e ruoli ──
  // Si usa il pattern della rotta (non l'URL grezzo: /%61pi/... sfuggiva al vecchio controllo)
  // e ruolo/stato vengono riletti dal DB a ogni richiesta: disattivazioni e declassamenti valgono subito.
  app.decorateRequest('utente', null);
  app.addHook('onRequest', async (req) => {
    const rotta = req.routeOptions?.url || '';
    let decodificato; try { decodificato = decodeURIComponent(req.url.split('?')[0]); } catch { throw httpErr(400, 'URL non valido'); }
    const api = rotta.startsWith('/api/') || decodificato.startsWith('/api/');
    if (!api || rotta === '/api/login') return;
    const t = leggiToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!t) throw httpErr(401, 'non autenticato');
    const { rows: [u] } = await pool.query('select id, ruolo, nome from utente where id=$1 and attivo', [t.id]);
    if (!u) throw httpErr(401, 'utente non valido');
    req.utente = u;
  });
  const soloOrg = async (req) => { if (!RUOLI_ORG.includes(req.utente.ruolo)) throw httpErr(403, 'permesso negato'); };
  const soloAdmin = async (req) => { if (req.utente.ruolo !== 'admin') throw httpErr(403, 'solo admin'); };
  // il giudice accede solo alle schede che gli sono assegnate
  const accessoScheda = async (utente, schedaId) => {
    if (RUOLI_ORG.includes(utente.ruolo)) return;
    const { rowCount } = await pool.query(
      `select 1 from assegnazione where scheda_id=$1 and utente_id=$2
       union all select 1 from scena_master m join scena_scheda s on s.scena_id = m.scena_id
        where s.id=$1 and m.utente_id=$2 and $3::text = 'giudice_master'`, [schedaId, utente.id, utente.ruolo]);
    if (!rowCount) throw httpErr(403, 'scheda non assegnata');
  };

  app.post('/api/login', async (req) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') throw httpErr(400, 'email e password obbligatorie');
    const chiave = `${req.ip}|${email.toLowerCase()}`;
    if (troppiTentativi(chiave)) throw httpErr(429, 'troppi tentativi: riprova tra qualche minuto');
    const { rows: [u] } = await pool.query('select * from utente where lower(email)=lower($1) and attivo', [email]);
    const ok = u ? verificaPassword(password, u.password_hash) : (verificaPasswordFinta(password), false);   // stesso tempo di risposta
    if (!ok) { registraFallimento(chiave); throw httpErr(401, 'credenziali errate'); }
    azzeraFallimenti(chiave);
    return { token: firmaToken({ id: u.id }), utente: { id: u.id, nome: u.nome, ruolo: u.ruolo } };
  });
  app.get('/api/me', async (req) => req.utente);

  // ── eventi, squadre, scene ──
  app.get('/api/eventi', async () => (await pool.query(
    `select id, codice, nome, tipo, luogo, to_char(data,'YYYY-MM-DD') as data, attivo, archiviato
       from evento where not archiviato order by data desc nulls last`)).rows);
  app.post('/api/eventi', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (!b.codice || !b.nome) throw httpErr(400, 'codice e nome obbligatori');
    return (await pool.query(
      `insert into evento (codice, nome, tipo, titolo_stampa, luogo, data) values ($1,$2,coalesce($3,'gara'),$4,$5,$6) returning *`,
      [b.codice, b.nome, b.tipo, b.titolo_stampa, b.luogo, b.data])).rows[0];
  });
  // un solo evento attivo alla volta (nel vecchio sistema se ne potevano attivare due)
  app.post('/api/eventi/:id/attiva', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const { rowCount } = await db.query('select 1 from evento where id=$1 and not archiviato', [req.params.id]);
    if (!rowCount) throw httpErr(404, 'evento inesistente o archiviato');
    await db.query('update evento set attivo=false, updated_at=now() where attivo');
    await db.query('update evento set attivo=true, updated_at=now() where id=$1', [req.params.id]);
    return { ok: true };
  }));
  app.get('/api/eventi/:id/squadre', async (req) =>
    (await pool.query('select id, numero, nome, comitato, attiva from squadra where evento_id=$1 order by numero', [req.params.id])).rows);
  app.post('/api/eventi/:id/squadre', { preHandler: soloOrg }, async (req) => {
    // il numero non si riusa mai (nel vecchio sistema Max+1 poteva riprendere un ID cancellato)
    return (await pool.query(
      `insert into squadra (evento_id, numero, nome, comitato)
       select $1, coalesce(max(numero),0)+1, $2, $3 from squadra where evento_id=$1 returning *`,
      [req.params.id, req.body.nome, (req.body.comitato || '').trim() || null])).rows[0];
  });
  app.patch('/api/squadre/:id', { preHandler: soloOrg }, async (req) =>
    (await pool.query(`update squadra set nome=coalesce($2,nome), attiva=coalesce($3,attiva),
         comitato = case when $4::boolean then nullif(trim($5),'') else comitato end, updated_at=now() where id=$1 returning *`,
      [req.params.id, req.body.nome ?? null, req.body.attiva ?? null, 'comitato' in req.body, req.body.comitato ?? ''])).rows[0]);

  app.get('/api/eventi/:id/scene', async (req) => {
    const { rows } = await pool.query(
      `select sc.id, sc.codice, sc.titolo,
         (select json_agg(json_build_object('id', s.id, 'slot', s.slot, 'titolo', s.titolo, 'simulatore', s.simulatore) order by s.slot)
            from scena_scheda s
            where s.scena_id = sc.id
              and ($2::text in ('admin','organizzazione') or exists
                   (select 1 from assegnazione a where a.scheda_id = s.id and a.utente_id = $3::uuid)
                  or ($2::text = 'giudice_master' and exists
                   (select 1 from scena_master m where m.scena_id = sc.id and m.utente_id = $3::uuid)))) as schede
       from scena sc where sc.evento_id=$1 order by sc.ordine, sc.codice`,
      [req.params.id, req.utente.ruolo, req.utente.id]);
    return rows;
  });
  app.post('/api/eventi/:id/scene', { preHandler: soloOrg }, async (req) => {
    const { codice, titolo, ordine } = req.body || {};
    if (!/^[A-Z0-9]{1,3}$/.test(codice || '')) throw httpErr(400, 'codice scena: 1-3 caratteri maiuscoli o cifre');
    if (!titolo || titolo.length > 120) throw httpErr(400, 'titolo obbligatorio (max 120 caratteri)');
    return creaScena(pool, { eventoId: req.params.id, codice, titolo, ordine });
  });
  app.post('/api/scene/:id/duplica', { preHandler: soloOrg }, async (req) =>
    inTransazione(pool, (db) => duplicaScena(db, { scenaId: req.params.id, ...req.body })));
  app.post('/api/scene/:id/schede', { preHandler: soloOrg }, async (req) =>
    inTransazione(pool, (db) => aggiungiSchedaDaPatologia(db, { scenaId: req.params.id, ...req.body })));
  app.get('/api/schede/:id', async (req) => {
    const { rows: [s] } = await pool.query('select * from scena_scheda where id=$1', [req.params.id]);
    if (!s) throw httpErr(404, 'scheda inesistente');
    await accessoScheda(req.utente, s.id);
    const voci = (await pool.query('select * from scena_scheda_voce where scheda_id=$1 order by ordine', [s.id])).rows;
    const LIVELLI = ['mb', 'be', 'su', 'in', 'ne'];
    s.voci = voci.map((v) => {
      const consentiti = LIVELLI.filter((l) => v[l] !== null).map((l) => l.toUpperCase());
      if (!RUOLI_ORG.includes(req.utente.ruolo)) {      // chi inserisce i dati non deve conoscere il valore dei punti
        return { id: v.id, scheda_id: v.scheda_id, ordine: v.ordine, sezione: v.sezione, testo: v.testo, consentiti };
      }
      return { ...v, consentiti };
    });
    return s;
  });
  // override per scena: solo i campi presenti nel corpo vengono cambiati (null = livello non consentito)
  app.put('/api/schede/:id/voci/:ordine', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const b = req.body || {};
    const { rows: [v] } = await db.query('select * from scena_scheda_voce where scheda_id=$1 and ordine=$2 for update', [req.params.id, req.params.ordine]);
    if (!v) throw httpErr(404, 'voce inesistente');
    const nuovo = { ...v };
    for (const l of ['mb', 'be', 'su', 'in', 'ne']) if (l in b) {
      if (b[l] !== null && !Number.isInteger(b[l])) throw httpErr(400, `${l}: numero intero o null`);
      nuovo[l] = b[l];
    }
    if (typeof b.testo === 'string' && b.testo.trim()) nuovo.testo = b.testo.trim();
    if (typeof b.is_sep === 'boolean') nuovo.is_sep = b.is_sep;
    if (['mb', 'be', 'su', 'in', 'ne'].every((l) => nuovo[l] === null)) throw httpErr(400, 'almeno un livello deve restare selezionabile');
    for (const l of ['mb', 'be', 'su', 'in', 'ne']) if (v[l] !== null && nuovo[l] === null) {
      const { rowCount } = await db.query('select 1 from risposta where voce_id=$1 and livello=$2::livello', [v.id, l.toUpperCase()]);
      if (rowCount) throw httpErr(409, `il livello ${l.toUpperCase()} è già stato usato in valutazioni: non può essere disattivato`);
    }
    const { rows: [r] } = await db.query(
      `update scena_scheda_voce set testo=$3, mb=$4, be=$5, su=$6, "in"=$7, ne=$8, is_sep=$9, scala='personalizzata'
       where id=$1 and $2::int = ordine returning *`,
      [v.id, v.ordine, nuovo.testo, nuovo.mb, nuovo.be, nuovo.su, nuovo.in, nuovo.ne, nuovo.is_sep]);
    await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'modifica_voce','scena_scheda_voce',$2,$3)`,
      [req.utente.id, v.id, JSON.stringify({ prima: v, dopo: r })]);
    return r;
  }));

  // ── libreria ──
  app.get('/api/libreria/scale', { preHandler: soloOrg }, async () => (await pool.query('select * from scala_punteggio order by codice')).rows);
  app.get('/api/libreria/voci', { preHandler: soloOrg }, async (req) => (await pool.query(
    `select * from voce where $1::text is null or testo ilike '%'||$1||'%' order by testo limit 200`, [req.query.q ?? null])).rows);
  app.get('/api/libreria/patologie', { preHandler: soloOrg }, async () => (await pool.query(
    `select p.*, (select count(*) from patologia_voce where patologia_id=p.id) as voci from patologia p order by nome`)).rows);
  app.get('/api/libreria/patologie/:id', { preHandler: soloOrg }, async (req) => (await pool.query(
    `select pv.ordine, pv.sezione, v.testo, sp.codice as scala, pv.is_sep from patologia_voce pv
       join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id
      where pv.patologia_id=$1 order by pv.ordine`, [req.params.id])).rows);
  app.post('/api/libreria/patologie', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const b = req.body;   // { codice, nome, sigla, is_bls, is_master, voci:[{sezione, testo, scala, is_sep}] }
    const { rows: [p] } = await db.query(
      `insert into patologia (codice, nome, sigla, is_bls, is_master) values ($1,$2,$3,coalesce($4,false),coalesce($5,false)) returning *`,
      [b.codice, b.nome, b.sigla, b.is_bls, b.is_master]);
    let o = 0;
    for (const v of b.voci || []) {
      const { rows: [voce] } = await db.query(
        `insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo=voce.testo returning id`, [v.testo]);
      const { rows: [sc] } = await db.query('select id from scala_punteggio where codice=$1', [v.scala || 'Standard']);
      if (!sc) throw httpErr(400, `scala inesistente: ${v.scala}`);
      await db.query(`insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,$6)`,
        [p.id, ++o, v.sezione, voce.id, sc.id, !!v.is_sep]);
    }
    return p;
  }));

  // ── compilazione ──
  app.get('/api/compilazioni', async (req) => {
    const { scheda, squadra } = req.query;
    await accessoScheda(req.utente, scheda);
    const { rows: [c] } = await pool.query('select * from compilazione where scheda_id=$1 and squadra_id=$2', [scheda, squadra]);
    const risposte = c ? (await pool.query('select voce_id, livello, updated_at from risposta where compilazione_id=$1 and livello is not null', [c.id])).rows : [];
    return { compilazione: c ?? null, risposte };
  });
  app.post('/api/sync', async (req) => {
    // accetta un oggetto o un array di compilazioni (batch dal tablet / trascrizione massiva dalla carta)
    const lista = Array.isArray(req.body) ? req.body : [req.body];
    if (lista.length > 200) throw httpErr(400, 'troppe compilazioni in un invio (max 200)');
    // un'unica transazione (o tutto o niente). Le compilazioni sono elaborate in ordine fisso
    // (scheda, squadra) per evitare deadlock tra invii concorrenti; su deadlock si riprova.
    const ordine = lista.map((p, i) => i).sort((a, b) => `${lista[a]?.scheda_id}${lista[a]?.squadra_id}`.localeCompare(`${lista[b]?.scheda_id}${lista[b]?.squadra_id}`));
    for (let tentativo = 1; ; tentativo++) {
      try {
        return await inTransazione(pool, async (db) => {
          const esiti = new Array(lista.length);
          for (const i of ordine) esiti[i] = await sincronizza(db, req.utente, lista[i]);
          return esiti;
        });
      } catch (e) { if (e.code === '40P01' && tentativo < 4) continue; throw e; }
    }
  });
  app.post('/api/compilazioni/:id/riapri', async (req) => inTransazione(pool, async (db) => {
    await riapri(db, req.utente, req.params.id); return { ok: true };
  }));

  // ── classifiche, monitor, stampa ──
  app.get('/api/eventi/:id/classifica', { preHandler: soloOrg }, async (req) => {   // i giudici non vedono punteggi né classifica
    const tipo = { generale: 'totale', sep: 'sep', bls: 'bls', master: 'master' }[req.query.tipo || 'generale'];
    if (!tipo) throw httpErr(400, 'tipo: generale|sep|bls|master');
    const { rows } = await pool.query(
      `select numero, nome, totale, sep, bls, master, (rank() over (order by ${tipo} desc))::int as posizione
         from v_classifica where evento_id=$1
          and exists (select 1 from squadra s where s.id = squadra_id and s.attiva)
        order by ${tipo} desc, numero`, [req.params.id]);
    const { rows: [m] } = await pool.query('select max_totale, max_sep from v_massimi_evento where evento_id=$1', [req.params.id]);
    return { massimi: m ?? null, classifica: rows };
  });
  app.get('/api/eventi/:id/monitor', { preHandler: soloOrg }, async (req) =>
    (await pool.query('select * from v_monitor where evento_id=$1 order by scena, squadra, slot', [req.params.id])).rows);
  app.get('/api/eventi/:id/stampa.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const q = req.query;
    if (q.squadra && !/^\d+(,\d+)*$/.test(q.squadra)) throw httpErr(400, 'squadra: numeri separati da virgola');
    const { pdf } = await generaPdfSchede(pool, {
      eventoId: req.params.id, scenaCodice: q.scena || undefined,
      squadraNumeri: q.squadra ? q.squadra.split(',').map(Number) : undefined, vuote: q.vuote !== '0' });
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="schede.pdf"').send(pdf);
  });

  // ── importazione di una scena da file Excel (formato GareCRI): un file per chiamata, in un'unica transazione ──
  app.post('/api/import/excel', { preHandler: soloOrg, bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const b = req.body || {};
    if (typeof b.dati !== 'string' || b.dati.length < 100) throw httpErr(400, 'file mancante');
    const buf = Buffer.from(b.dati, 'base64');
    if (buf.subarray(0, 2).toString() !== 'PK') throw httpErr(400, 'non è un file .xlsx');
    const tipoEvento = b.tipo === 'olimpiadi' ? 'olimpiadi' : 'gara';
    if (!b.evento_id && (!b.evento?.codice?.trim() || !b.evento?.nome?.trim())) throw httpErr(400, 'indica un evento esistente oppure codice e nome del nuovo evento');
    const e = b.evento || {};
    return inTransazione(pool, (db) => importaExcel(db, buf, {
      eventoId: b.evento_id || undefined, eventoCodice: e.codice?.trim(), nomeEvento: e.nome?.trim(), titoloStampa: e.titolo_stampa?.trim() || e.nome?.trim(),
      luogo: e.luogo?.trim() || null, data: e.data || null, tipoEvento, attiva: false }));
  });

  registraGestione(app, pool, { soloOrg, soloAdmin });

  app.setErrorHandler((err, req, reply) => {
    let status = err.statusCode || 500, msg = err.message;
    if (!err.statusCode && err.code) {
      if (err.code === '23503') { status = 409; msg = 'operazione non consentita: esistono dati collegati'; }
      else if (err.code === '23505') { status = 409; msg = 'valore già esistente'; }
      else if (err.code.startsWith('22') || err.code.startsWith('23')) { status = 400; msg = 'dati non validi'; }
    }
    if (status >= 500) { req.log.error(err); msg = 'errore interno'; }
    reply.code(status).send({ errore: msg });
  });

  app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web', import.meta.url)) });
  return app;
}
