import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { firmaToken, leggiToken, verificaPassword, troppiTentativi, registraFallimento, azzeraFallimenti, verificaPasswordFinta } from './auth.js';
import { inTransazione } from './db.js';
import { sincronizza, riapri, httpErr } from './services/compilazioni.js';
import { generaPdfSchede } from './services/stampa.js';
import { creaDocumento, disegnaScheda } from './pdf/scheda.js';
import { registraGestione } from './routes-gestione.js';
import { aggiungiSchedaDaPatologia, creaScena, duplicaScena } from './services/scene.js';
import { importaExcel } from './services/import-excel.js';
import { ruoloEffettivo, areeRichieste } from './permessi.js';
import { registraRichieste } from './routes-richieste.js';
import { registraSegreteria } from './routes-segreteria.js';
import { registraRisorse } from './routes-risorse.js';
import { registraDocumenti } from './routes-documenti.js';
import { registraEsami } from './routes-esami.js';
import { registraComitati } from './routes-comitati.js';
import { canonico } from './comitati.js';
import { generaClassificaPdf } from './pdf/classifica.js';
import { generaEsitoPdf } from './pdf/esito.js';
import { registraAi } from './routes-ai.js';
import { profiloFormativo, puoGestireEvento, soloFormazione, TIPI_CORSO } from './ambito.js';
import { haSchede, comitatoDi, controllaScheda } from './libreria-ambito.js';
import { registraAuth, creaSessione, profilo, mfaObbligatoria, SQL_UTENTE } from './routes-auth.js';

const RUOLI_ORG = ['admin', 'organizzazione'];
const TIPI_EVENTO = ['gara', 'olimpiadi', 'allenamento', 'corso', 'esame', 'megacode'];

export function buildApp(pool, { logger = false, fetchImpl } = {}) {
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY === '1' });   // TRUST_PROXY=1 solo dietro a un proxy fidato (es. hosting con HTTPS)
  app.addHook('onError', async (req, reply, err) => { if (process.env.DEBUG_ERR) console.error('ERR', err); });

  // ── sicurezza: intestazioni ──
  app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; frame-src blob:; base-uri 'none'; frame-ancestors 'self'");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  // controllo di salute (pubblico, senza dati): usato dall'hosting e per tenere sveglio il servizio
  app.get('/salute', async () => { await pool.query('select 1'); return { ok: true }; });

  // evento a cui appartiene la risorsa richiesta (null se la rotta non è legata a un evento)
  const eventoDellaRotta = async (rotta, params = {}) => {
    const id = params.id; if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const Q = { '/api/eventi/': null, '/api/scene/': 'select evento_id from scena where id=$1', '/api/schede/': 'select sc.evento_id from scena_scheda s join scena sc on sc.id = s.scena_id where s.id=$1',
      '/api/squadre/': 'select evento_id from squadra where id=$1', '/api/iscritti/': 'select evento_id from iscrizione where id=$1', '/api/iscrizioni/': 'select evento_id from iscrizione where id=$1' };
    for (const [pre, q] of Object.entries(Q)) if (rotta.startsWith(pre)) return q ? ((await pool.query(q, [id])).rows[0]?.evento_id ?? null) : id.toLowerCase();
    return null;
  };
  // ── autenticazione e ruoli ──
  // Si usa il pattern della rotta (non l'URL grezzo: /%61pi/... sfuggiva al vecchio controllo)
  // e ruolo/stato vengono riletti dal DB a ogni richiesta: disattivazioni e declassamenti valgono subito.
  app.decorateRequest('utente', null);
  app.addHook('onRequest', async (req) => {
    const rotta = req.routeOptions?.url || '';
    let decodificato; try { decodificato = decodeURIComponent(req.url.split('?')[0]); } catch { throw httpErr(400, 'URL non valido'); }
    const api = rotta.startsWith('/api/') || decodificato.startsWith('/api/');
    if (!api || ['/api/login', '/api/login/mfa', '/api/pubblico'].includes(rotta) || rotta.startsWith('/api/auth/')) return;
    const t = leggiToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!t) throw httpErr(401, 'non autenticato');
    if (t.rid) {                                   // sessione di chi non è ancora registrato: solo il modulo di richiesta
      const { rows: [r] } = await pool.query('select * from richiesta_accesso where id=$1 and scade_il > now()', [t.rid]);
      if (!r) throw httpErr(401, 'richiesta scaduta: accedi di nuovo per ripresentarla');
      if (!['/api/me', '/api/registrazione', '/api/comitati/cerca'].includes(rotta)) throw httpErr(403, 'accesso in attesa di approvazione');
      req.richiesta = r; return;
    }
    const { rows: [u] } = await pool.query(SQL_UTENTE + ' where u.id=$1 and u.attivo', [t.id]);
    if (!u) throw httpErr(401, 'utente non valido');
    req.utente = { id: u.id, nome: u.nome, evento_id: u.evento_id, eventi_ammessi: (u.ev_ruoli || []).map((r) => r.evento_id), per_evento: !!u.per_evento, eventi_org: u.ev_org || [], mfa_attiva: u.mfa_attiva, admin: u.admin, aree: u.aree, ruolo_codice: u.ruolo, ruolo: ruoloEffettivo(u), via: t.via || 'pwd' };
    // organizzazione e admin con password devono prima attivare la MFA: fino ad allora solo la pagina di configurazione
    if (mfaObbligatoria(u, req.utente.via) && !(rotta === '/api/me' || rotta.startsWith('/api/mfa'))) throw httpErr(403, 'configura_mfa');
    if (req.utente.ruolo === 'organizzazione') {                 // ruolo con aree: solo quelle consentite
      const serve = areeRichieste(req.method, rotta);
      if (serve && !serve.some((a) => u.aree.includes(a))) throw httpErr(403, 'area non consentita al tuo ruolo');
    }
    if (req.utente.ruolo === 'organizzazione' && u.per_evento) {      // organizzazione per evento: solo le gare a cui è iscritta come organizzazione
      const ev = await eventoDellaRotta(rotta, req.params);
      if (ev && !req.utente.eventi_org.includes(ev)) throw httpErr(403, 'gara non assegnata');
      if (rotta === '/api/eventi' && req.method === 'POST') throw httpErr(403, 'non puoi creare eventi: chiedi a un admin');
    }
    if (req.utente.ruolo === 'partecipante' && !(rotta === '/api/me' || rotta.startsWith('/api/me/') || rotta.startsWith('/api/mfa') || (req.method === 'GET' && ['/api/avvisi', '/api/eventi', '/api/documenti'].includes(rotta))))
      throw httpErr(403, 'permesso negato');            // il partecipante vede solo home e notizie
    if (!RUOLI_ORG.includes(req.utente.ruolo) && u.evento_id) {     // chi è legato a una gara non esce da quella gara
      const m = req.url.match(/^\/api\/eventi\/([0-9a-f-]{36})/i);
      if (m && m[1].toLowerCase() !== u.evento_id) throw httpErr(403, 'gara non assegnata');
    }
    if (!RUOLI_ORG.includes(req.utente.ruolo) && !u.evento_id && !(u.aree || []).includes('valutazione') && (u.ev_ruoli || []).length) {   // accesso solo per le gare a cui è iscritto
      const m = req.url.match(/^\/api\/eventi\/([0-9a-f-]{36})/i);
      if (m && !req.utente.eventi_ammessi.includes(m[1].toLowerCase())) throw httpErr(403, 'gara non assegnata');
    }
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
    const { rows: [u] } = await pool.query(SQL_UTENTE + ' where lower(u.email)=lower($1) and u.attivo', [email]);
    const ok = u ? verificaPassword(password, u.password_hash) : (verificaPasswordFinta(password), false);   // stesso tempo di risposta
    if (!ok) { registraFallimento(chiave); throw httpErr(401, 'credenziali errate'); }
    azzeraFallimenti(chiave);
    if (u.mfa_attiva) return { mfa: true, ticket: firmaToken({ id: u.id, t: 'mfa' }, 0.1) };   // 6 minuti per inserire il codice
    return creaSessione(u, 'pwd');
  });
  app.get('/api/me', async (req) => req.richiesta ? { in_attesa: true, nome: [req.richiesta.nome, req.richiesta.cognome].filter(Boolean).join(' ') || req.richiesta.email, compilata: req.richiesta.compilata } : profilo((await pool.query(SQL_UTENTE + ' where u.id=$1', [req.utente.id])).rows[0], req.utente.via));

  app.patch('/api/me/tema', async (req) => {          // l'aspetto lo sceglie ognuno per sé, qualunque ruolo
    const t = req.body?.tema;
    if (!['a', 'b', 'c'].includes(t)) throw httpErr(400, 'tema: a, b o c');
    await pool.query('update utente set tema=$2 where id=$1', [req.utente.id, t]);
    return { ok: true, tema: t };
  });

  // ── pagina pubblica (senza login): notizie, gare, percorso ──
  app.get('/api/pubblico', async () => {
    const { rows: avvisi } = await pool.query(`select id, titolo, testo, created_at from avviso where pubblico order by created_at desc limit 20`);
    const { rows: eventi } = await pool.query(
      `select id, nome, tipo, luogo, to_char(data,'YYYY-MM-DD') as data, attivo, mappa_url from evento where not archiviato order by data desc nulls last limit 20`);
    const { rows: scene } = await pool.query(
      `select s.evento_id, s.codice, s.titolo, s.indirizzo, s.lat, s.lng from scena s join evento e on e.id=s.evento_id
        where not e.archiviato and (s.indirizzo is not null or s.lat is not null) order by s.ordine, s.codice`);
    return { avvisi, eventi: eventi.map((e) => ({ ...e, scene: scene.filter((s) => s.evento_id === e.id) })) };
  });

  // ── bacheca avvisi della Home ──
  app.get('/api/avvisi', async (req) => {
    const ev = req.query.evento || null;
    return (await pool.query(
      `select id, evento_id, titolo, testo, pubblico, created_at from avviso
        where evento_id is null or evento_id = $1::uuid order by created_at desc limit 20`, [ev])).rows;
  });
  app.post('/api/avvisi', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (!b.titolo || !String(b.titolo).trim()) throw httpErr(400, 'titolo obbligatorio');
    return (await pool.query('insert into avviso (evento_id, titolo, testo, pubblico) values ($1,$2,$3,$4) returning *',
      [b.evento_id || null, String(b.titolo).trim(), b.testo || null, b.pubblico === true])).rows[0];
  });
  app.delete('/api/avvisi/:id', { preHandler: soloOrg }, async (req) => { await pool.query('delete from avviso where id=$1', [req.params.id]); return { ok: true }; });

  // ── eventi, squadre, scene ──
  app.get('/api/eventi', async (req) => {   // i giudici vedono solo la gara a cui sono legati (o quella attiva); organizzazione e admin tutte
    const org = RUOLI_ORG.includes(req.utente.ruolo);
    const righe = (await pool.query(
      `select id, codice, nome, tipo, luogo, to_char(data,'YYYY-MM-DD') as data, attivo, archiviato, mappa_url, soglia_pct, mostra_punteggi, codice_gaia, corso_id, comitato
         from evento where ($1 or id = $2 or id = any($3::uuid[]) or ($2::uuid is null and not cardinality($3::uuid[]) > 0 and attivo)) and ($1 or not archiviato)
        order by data desc nulls last`, [org, req.utente.evento_id, req.utente.eventi_ammessi])).rows;
    if (req.utente.ruolo === 'organizzazione' && req.utente.per_evento) return righe.filter((e) => req.utente.eventi_org.includes(e.id));
    if (!soloFormazione(req.utente)) return righe;                                // chi gestisce solo i corsi vede i corsi del suo ambito
    const prof = await profiloFormativo(pool, req.utente.id), out = [];
    for (const e of righe) if (await puoGestireEvento(pool, req.utente, e, prof)) out.push(e);
    return out;
  });
  app.post('/api/eventi', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (!b.codice || !b.nome) throw httpErr(400, 'codice e nome obbligatori');
    if (b.tipo && !TIPI_EVENTO.includes(b.tipo)) throw httpErr(400, 'tipo di evento non valido');
    const tipo = b.tipo || 'gara';
    let comitato = typeof b.comitato === 'string' && b.comitato.trim() ? (await canonico(pool, b.comitato.trim())).nome : null;
    if (soloFormazione(req.utente)) {
      if (!TIPI_CORSO.includes(tipo)) throw httpErr(403, 'puoi creare solo corsi, Mega Code ed esami');
      const prof = await profiloFormativo(pool, req.utente.id);
      if (!prof.locale && !prof.nazionale) throw httpErr(403, 'serve una qualifica di trainer, monitore, formatore o capo monitore');
      if (!prof.nazionale) { if (!prof.comitato) throw httpErr(400, 'imposta il tuo comitato in anagrafica'); comitato = prof.comitato; }   // il trainer crea per il suo comitato
      else comitato = comitato || prof.comitato;
      if (b.corso_id) { const { rows: [c] } = await pool.query('select id, tipo, comitato, corso_id from evento where id=$1', [b.corso_id]); if (!c || !(await puoGestireEvento(pool, req.utente, c, prof))) throw httpErr(403, 'corso non nel tuo ambito'); }
    }
    const didattico = ['allenamento', 'corso', 'esame', 'megacode'].includes(tipo);
    return (await pool.query(
      `insert into evento (codice, nome, tipo, titolo_stampa, luogo, data, mostra_punteggi, soglia_pct, codice_gaia, corso_id, comitato) values ($1,$2,$3,$4,$5,$6,$7,$8,nullif(trim($9),''),$10,$11) returning *`,
      [b.codice, b.nome, tipo, b.titolo_stampa, b.luogo, b.data, didattico, tipo === 'esame' ? 75 : null, b.codice_gaia ?? '', b.corso_id || null, comitato])).rows[0];
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
      [req.params.id, req.body.nome, (await canonico(pool, req.body.comitato)).nome])).rows[0];
  });
  app.patch('/api/squadre/:id', { preHandler: soloOrg }, async (req) =>
    (await pool.query(`update squadra set nome=coalesce($2,nome), attiva=coalesce($3,attiva),
         comitato = case when $4::boolean then nullif(trim($5),'') else comitato end, updated_at=now() where id=$1 returning *`,
      [req.params.id, req.body.nome ?? null, req.body.attiva ?? null, 'comitato' in req.body, (await canonico(pool, req.body.comitato)).nome ?? ''])).rows[0]);

  app.get('/api/eventi/:id/scene', async (req) => {
    const { rows } = await pool.query(
      `select sc.id, sc.codice, sc.titolo, sc.indirizzo, sc.lat, sc.lng,
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
    const { rows: [ve] } = await pool.query('select e.tipo, e.soglia_pct, e.mostra_punteggi from scena sc join evento e on e.id = sc.evento_id where sc.id=$1', [s.scena_id]);
    s.evento = ve;
    const LIVELLI = ['mb', 'be', 'su', 'in', 'ne'];
    s.voci = voci.map((v) => {
      const consentiti = LIVELLI.filter((l) => v[l] !== null).map((l) => l.toUpperCase());
      if (!RUOLI_ORG.includes(req.utente.ruolo)) {      // chi inserisce i dati non deve conoscere il valore dei punti (salvo esami, corsi e allenamenti)
        const base = { id: v.id, scheda_id: v.scheda_id, ordine: v.ordine, sezione: v.sezione, testo: v.testo, consentiti };
        if (ve?.mostra_punteggi) base.punti = Object.fromEntries(LIVELLI.filter((l) => v[l] !== null).map((l) => [l.toUpperCase(), v[l]]));
        return base;
      }
      return { ...v, consentiti };
    });
    return s;
  });
  // esito di una scheda per una squadra/candidato (esami, corsi, allenamenti): punti, percentuale, soglia, PDF
  app.get('/api/schede/:id/esito.pdf', async (req, reply) => {
    const { rows: [s] } = await pool.query('select * from scena_scheda where id=$1', [req.params.id]);
    if (!s) throw httpErr(404, 'scheda inesistente');
    await accessoScheda(req.utente, s.id);
    const sq = req.query.squadra;
    if (!/^[0-9a-f-]{36}$/i.test(sq || '')) throw httpErr(400, 'squadra non valida');
    const { rows: [e] } = await pool.query(`select e.nome, e.luogo, e.tipo, e.soglia_pct, e.mostra_punteggi, to_char(e.data,'YYYY-MM-DD') as data, sc.codice as scena
      from scena sc join evento e on e.id = sc.evento_id where sc.id=$1`, [s.scena_id]);
    if (!RUOLI_ORG.includes(req.utente.ruolo) && !e.mostra_punteggi) throw httpErr(403, 'esito non disponibile per questo evento');
    const { rows: [q] } = await pool.query('select nome, comitato from squadra where id=$1 and evento_id=(select evento_id from scena where id=$2)', [sq, s.scena_id]);
    if (!q) throw httpErr(404, 'squadra inesistente');
    const { rows: [c] } = await pool.query('select id, giudice, stato, completata_at from compilazione where scheda_id=$1 and squadra_id=$2', [s.id, sq]);
    const { rows: voci } = await pool.query(
      `select v.ordine, v.sezione, v.testo, r.livello,
              case r.livello when 'MB' then v.mb when 'BE' then v.be when 'SU' then v.su when 'IN' then v."in" when 'NE' then v.ne end as punti,
              coalesce(greatest(v.mb, v.be, v.su, v."in", v.ne), 0) as max, (v.be is null and v."in" is null) as tre
         from scena_scheda_voce v left join risposta r on r.voce_id = v.id and r.compilazione_id = $2 where v.scheda_id=$1 order by v.ordine`, [s.id, c?.id ?? null]);
    const punti = voci.reduce((a, v) => a + (v.livello ? Number(v.punti) : 0), 0), massimo = voci.reduce((a, v) => a + Number(v.max), 0);
    const pdf = await generaEsitoPdf({ evento: e, scheda: s.titolo, candidato: q, giudice: c?.giudice, voci, punti, massimo, soglia: e.soglia_pct ? Number(e.soglia_pct) : null, fasce: s.fasce });
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="esito.pdf"').send(pdf);
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
  app.get('/api/libreria/patologie', { preHandler: soloOrg }, async (req) => {
    // generale per tutti; le schede dei comitati solo se la direzione le chiede (?comitati=1) o per il proprio comitato
    const tutte = haSchede(req.utente) && req.query.comitati === '1';
    const mio = haSchede(req.utente) ? null : await comitatoDi(pool, req.utente);
    return (await pool.query(
    `select p.*, (select count(*) from patologia_voce where patologia_id=p.id) as voci,
       (select coalesce(jsonb_agg(jsonb_build_object('evento', x.nome, 'codice', x.codice, 'luogo', x.luogo, 'data', to_char(x.data, 'YYYY-MM-DD')) order by x.data desc nulls last), '[]'::jsonb)
          from (select distinct e.id, e.nome, e.codice, e.luogo, e.data from scena_scheda ss join scena s on s.id = ss.scena_id join evento e on e.id = s.evento_id where ss.patologia_id = p.id) x) as usi
       from patologia p where (p.comitato is null or $1::boolean or lower(trim(p.comitato)) = lower(trim($2::text))) and (not p.bozza or p.creata_da = $3::uuid) order by nome`, [tutte, mio, req.utente.id])).rows;
  });
  app.get('/api/libreria/patologie/:id', { preHandler: soloOrg }, async (req) => { await controllaScheda(pool, req.utente, req.params.id, { modifica: false }); return (await pool.query(
    `select pv.ordine, pv.sezione, v.testo, sp.codice as scala, pv.is_sep from patologia_voce pv
       join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id
      where pv.patologia_id=$1 order by pv.ordine`, [req.params.id])).rows; });
  // anteprima di una scheda della libreria con lo stesso template delle schede stampate (PDF)
  app.get('/api/libreria/patologie/:id/anteprima.pdf', { preHandler: soloOrg }, async (req, reply) => {
    await controllaScheda(pool, req.utente, req.params.id, { modifica: false });
    const { rows: [pt] } = await pool.query('select nome, sigla, is_master from patologia where id=$1', [req.params.id]);
    const { rows: voci } = await pool.query(
      `select pv.ordine as id, pv.sezione, v.testo, pv.is_sep, sp.mb, sp.be, sp.su, sp."in", sp.ne from patologia_voce pv
         join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id where pv.patologia_id=$1 order by pv.ordine`, [req.params.id]);
    const doc = creaDocumento(); const chunks = []; doc.on('data', (c) => chunks.push(c)); const fine = new Promise((r) => doc.on('end', r));
    disegnaScheda(doc, { evento: { nome: 'Anteprima scheda', titolo_stampa: 'Anteprima scheda', luogo: '', data_txt: null }, squadra: { numero: 0, nome: 'Test' },
      scena: { codice: 'T', titolo: 'Nome Scena' }, scheda: { simulatore: 'M', titolo: pt.nome, is_master: pt.is_master, parametri: { coscienza: 'Vigile', fr: 16, fc: 80, cute: 'Normale' } }, voci, compilazione: null, risposte: new Map(), vuota: true });
    doc.end(); await fine;
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="anteprima.pdf"').send(Buffer.concat(chunks));
  });
  app.post('/api/libreria/patologie', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const b = req.body;   // { codice, nome, sigla, is_bls, is_master, voci:[{sezione, testo, scala, is_sep}] }
    // chi ha solo l'area «schede del proprio comitato» crea schede private del suo comitato; la direzione crea quelle generali
    let comitato = null, codice = b.codice;
    if (!haSchede(req.utente)) {
      comitato = await comitatoDi(pool, req.utente);
      if (!comitato) throw httpErr(400, 'il tuo comitato non risulta in anagrafica: chiedi all\'organizzazione di completarlo');
      const slug = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
      codice = `${slug(comitato)}-${slug(b.nome || 'SCHEDA')}`.slice(0, 60);
      for (let n = 2; (await db.query('select 1 from patologia where codice=$1', [codice])).rowCount; n++) codice = `${codice.replace(/-\d+$/, '')}-${n}`;
    }
    const { rows: [p] } = await db.query(
      `insert into patologia (codice, nome, sigla, is_bls, is_master, is_diu, categoria, categoria2, comitato, creata_da) values ($1,$2,$3,coalesce($4,false),coalesce($5,false),coalesce($6,false),$7,$8,$9,$10) returning *`,
      [codice, b.nome, b.sigla, b.is_bls, b.is_master, b.is_diu, (b.categoria || '').trim() || b.nome, (b.categoria2 || '').trim() || null, comitato, req.utente.id]);
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
  const CLASS = { generale: ['totale', 'Generale'], sep: ['sep', 'SEP'], bls: ['bls', 'BLSD'], master: ['master', 'Master'], diu: ['diu', 'DIU'] };
  const leggiClassifica = async (eventoId, tipoReq) => {
    const def = CLASS[tipoReq || 'generale'];
    if (!def) throw httpErr(400, 'tipo: generale|sep|bls|master|diu');
    const tipo = def[0];
    const { rows } = await pool.query(
      `select numero, nome, totale, sep, bls, master, diu, ${tipo} as valore, (rank() over (order by ${tipo} desc))::int as posizione
         from v_classifica where evento_id=$1
          and exists (select 1 from squadra s where s.id = squadra_id and s.attiva)
        order by ${tipo} desc, numero`, [eventoId]);
    const { rows: [m] } = await pool.query('select max_totale, max_sep from v_massimi_evento where evento_id=$1', [eventoId]);
    return { massimi: m ?? null, classifica: rows, nome: def[1], max: tipoReq === 'sep' ? m?.max_sep : (!tipoReq || tipoReq === 'generale') ? m?.max_totale : null };
  };
  app.get('/api/eventi/:id/classifica', { preHandler: soloOrg }, async (req) => {   // i giudici non vedono punteggi né classifica
    const { massimi, classifica } = await leggiClassifica(req.params.id, req.query.tipo);
    return { massimi, classifica };
  });
  app.get('/api/eventi/:id/classifica.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const c = await leggiClassifica(req.params.id, req.query.tipo);
    const { rows: [evento] } = await pool.query(`select nome, luogo, to_char(data,'YYYY-MM-DD') as data from evento where id=$1`, [req.params.id]);
    if (!evento) throw httpErr(404, 'gara inesistente');
    const pdf = await generaClassificaPdf({ evento, nomeClassifica: c.nome, righe: c.classifica, max: c.max ? Number(c.max) : null });
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="classifica.pdf"').send(pdf);
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
      luogo: e.luogo?.trim() || null, data: e.data || null, tipoEvento, attiva: false, sostituisci: b.sostituisci === true }));
  });

  registraGestione(app, pool, { soloOrg, soloAdmin });
  registraAuth(app, pool, { fetchImpl, soloAdmin });
  registraRichieste(app, pool, { soloAdmin, fetchImpl });
  registraSegreteria(app, pool, { soloOrg });
  registraRisorse(app, pool, { inTransazione, soloOrg });
  registraDocumenti(app, pool, { soloOrg });
  registraEsami(app, pool, { soloOrg });
  registraComitati(app, pool, { soloOrg });
  registraAi(app, pool, { soloOrg, inTransazione });

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
