import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { firmaToken, leggiToken, verificaPassword, troppiTentativi, registraFallimento, azzeraFallimenti, verificaPasswordFinta } from './auth.js';
import { inTransazione } from './db.js';
import { sincronizza, riapri, httpErr } from './services/compilazioni.js';
import { generaPdfSchede } from './services/stampa.js';
import { creaDocumento, disegnaScheda } from './pdf/scheda.js';
import { registraGestione } from './routes-gestione.js';
import { registraTurni } from './routes-turni.js';
import { calcolaAvanzamento } from './services/avanzamento.js';
import { enteUtente, regioneDelComitato, puoVedereEvento, accessoEvento, verificaAccessoEvento, èApprovatore } from './enti.js';
import { trovaDoppioni, unisci, ignora } from './services/accorpamenti.js';
import { confronta, revisioni, proposteRaggruppamento, raggruppa, salvaRevisioneDaScena } from './services/revisioni.js';
import { proponi, approva, rifiuta, tutteLeRegioni, impostaCondivisione } from './services/promozioni.js';
import { importaCanovaccio } from './services/canovaccio.js';
import { creaCanovaccio } from './pdf/canovaccio.js';
import fs from 'node:fs';
import { creaScenario } from './pdf/scenario.js';
import { normalizzaDati, validaIntestazione } from './services/canovaccio-nuovo.js';
import { aggiungiSchedaDaPatologia, CODICE_SCENA, creaScena, duplicaScena, aggiornaElencoPazienti } from './services/scene.js';
import { importaExcel } from './services/import-excel.js';
import { èAllInOne, importaAllInOne, importaValutazioniAllInOne } from './services/import-allinone.js';
import ExcelJS from 'exceljs';
import { ruoloEffettivo, areeRichieste } from './permessi.js';
import { registraRichieste } from './routes-richieste.js';
import { registraNotifiche } from './notifiche.js';
import { leggiCoordinate } from './geo.js';
import { regioni as regioniComuni, province as provinceComuni, cerca as cercaComuni, comunePerIstat, comuneDaLuogo, etichettaLuogo } from './comuni.js';
import { registraSegreteria } from './routes-segreteria.js';
import { registraRisorse } from './routes-risorse.js';
import { registraDocumenti } from './routes-documenti.js';
import { registraEsami } from './routes-esami.js';
import { registraComitati } from './routes-comitati.js';
import { canonico } from './comitati.js';
import { generaClassificaPdf } from './pdf/classifica.js';
import { generaEsitoPdf } from './pdf/esito.js';
import { fasceAuto } from './esito.js';
import { disegnaSkill } from './pdf/skill.js';
// una scheda è una "skill" (layout cartaceo 0-1-2) se la sua tipologia è solo skill/megacode o se è una scheda d'esame TSSA
const èSkill = (p) => p?.categoria === 'Esame TSSA' || (Array.isArray(p?.tipologie) && p.tipologie.includes('skill') && !p.tipologie.includes('gara') && !p.tipologie.includes('olimpiadi'));
import { registraAi } from './routes-ai.js';
import { profiloFormativo, puoGestireEvento, soloFormazione, TIPI_CORSO } from './ambito.js';
import { haSchede, comitatoDi, controllaScheda, tipologieValide } from './libreria-ambito.js';
import { registraAuth, creaSessione, profilo, mfaObbligatoria, SQL_UTENTE } from './routes-auth.js';

const RUOLI_ORG = ['admin', 'organizzazione'];
const SKILL_AUTO = ['esame', 'corso', 'megacode'];   // schede con fasce di giudizio calcolate sul numero di voci quando non ne hanno di proprie
const TIPI_EVENTO = ['gara', 'olimpiadi', 'allenamento', 'corso', 'esame', 'megacode', 'corso_giudici'];

export function buildApp(pool, { logger = false, fetchImpl } = {}) {
  const app = Fastify({ logger, trustProxy: process.env.TRUST_PROXY === '1' });   // TRUST_PROXY=1 solo dietro a un proxy fidato (es. hosting con HTTPS)
  app.addHook('onError', async (req, reply, err) => { if (process.env.DEBUG_ERR) console.error('ERR', err); });

  // ── sicurezza: intestazioni ──
  app.addHook('onSend', async (req, reply) => {
    if (req.routeOptions?.url?.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
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
    if (!api || ['/api/login', '/api/login/mfa', '/api/pubblico', '/api/registrati/inizia'].includes(rotta) || rotta.startsWith('/api/auth/')) return;
    const t = leggiToken((req.headers.authorization || '').replace(/^Bearer /, ''));
    // I ticket di secondo fattore e i cookie SSO non sono sessioni API.
    if (!t || t.t || t.p || (!t.id && !t.rid)) throw httpErr(401, 'non autenticato');
    if (t.rid) {                                   // sessione di chi non è ancora registrato: solo il modulo di richiesta
      const { rows: [r] } = await pool.query('select * from richiesta_accesso where id=$1 and scade_il > now()', [t.rid]);
      if (!r) throw httpErr(401, 'richiesta scaduta: accedi di nuovo per ripresentarla');
      if (!['/api/me', '/api/registrazione', '/api/registrazione/mfa', '/api/comitati/cerca'].includes(rotta)) throw httpErr(403, 'accesso in attesa di approvazione');
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
    if (req.utente.ruolo === 'organizzazione' && !u.per_evento) {      // eventi di un comitato o di una regione: li vede solo chi appartiene a quell'ente
      const idEv = await eventoDellaRotta(rotta, req.params);
      if (idEv) { const { rows: [e] } = await pool.query('select id, tipo, livello, comitato, regione from evento where id=$1', [idEv]);
        if (e) { const acc = await accessoEvento(pool, req.utente, e); if (!acc) throw httpErr(403, 'evento di un altro ente'); if (acc === 'lettura' && req.method !== 'GET') throw httpErr(403, 'il tuo comitato è invitato: puoi consultare l\'allenamento ma non modificarlo'); } }
    }
    if (req.utente.ruolo === 'partecipante' && !(rotta === '/api/me' || rotta.startsWith('/api/me/') || rotta.startsWith('/api/mfa') || (req.method === 'GET' && ['/api/avvisi', '/api/eventi', '/api/documenti'].includes(rotta)) || ((u.aree || []).includes('accompagnatore') && /\/(accompagnatore|attesa)$/.test(rotta))))
      throw httpErr(403, 'permesso negato');            // il partecipante vede solo home e notizie
    if (!RUOLI_ORG.includes(req.utente.ruolo) && u.evento_id) {     // chi è legato a una gara non esce da quella gara
      const m = rotta.startsWith('/api/eventi/:id') ? [null, req.params.id] : null;
      if (m && m[1].toLowerCase() !== u.evento_id) throw httpErr(403, 'gara non assegnata');
    }
    if (!RUOLI_ORG.includes(req.utente.ruolo) && !u.evento_id && !(u.aree || []).includes('valutazione') && (u.ev_ruoli || []).length) {   // accesso solo per le gare a cui è iscritto
      const m = rotta.startsWith('/api/eventi/:id') ? [null, req.params.id] : null;
      if (m && !req.utente.eventi_ammessi.includes(m[1].toLowerCase())) throw httpErr(403, 'gara non assegnata');
    }
  });
  const soloOrg = async (req) => { if (!RUOLI_ORG.includes(req.utente.ruolo)) throw httpErr(403, 'permesso negato'); };
  const soloAdmin = async (req) => { if (req.utente.ruolo !== 'admin') throw httpErr(403, 'solo admin'); };
  // il giudice accede solo alle schede che gli sono assegnate
  const accessoScheda = async (utente, schedaId) => {
    if (utente.ruolo === 'organizzazione') {
      const { rows: [s] } = await pool.query('select sc.evento_id from scena_scheda s join scena sc on sc.id=s.scena_id where s.id=$1', [schedaId]);
      if (!s) throw httpErr(404, 'scheda inesistente');
      await verificaAccessoEvento(pool, utente, s.evento_id, false);
    }
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
  // La pagina pubblica mostra solo gare e Olimpiadi, nella finestra di tre mesi prima e dopo (modificabile qui sotto)
  const FINESTRA_GIORNI = 92;
  app.get('/api/pubblico', async () => {
    const { rows: avvisi } = await pool.query(`select id, titolo, testo, created_at from avviso where pubblico and ambito='gare' order by created_at desc limit 20`);
    const visibile = `not e.archiviato and e.tipo in ('gara','olimpiadi') and (e.livello is null or (e.livello <> 'comitato' and e.attivo))
      and (e.attivo or coalesce(e.data_fine, e.data) between current_date - $1::int and current_date + $1::int)`;
    const { rows: eventi } = await pool.query(
      `select e.id, e.nome, e.tipo, e.luogo, to_char(e.data,'YYYY-MM-DD') as data, to_char(e.data_fine,'YYYY-MM-DD') as data_fine, e.attivo, e.modalita, e.mappa_url, coalesce(e.luogo_regione, e.regione) as regione, e.lat, e.lng, e.segreteria_lat, e.segreteria_lng
         from evento e where ${visibile} order by e.data desc nulls last limit 30`, [FINESTRA_GIORNI]);
    const { rows: scene } = await pool.query(
      `select s.evento_id, s.codice, s.titolo, s.indirizzo, s.lat, s.lng from scena s join evento e on e.id=s.evento_id
        where ${visibile} and (s.indirizzo is not null or s.lat is not null) order by s.ordine, s.codice`, [FINESTRA_GIORNI]);
    return { avvisi, eventi: eventi.map((e) => ({ ...e, scene: scene.filter((s) => s.evento_id === e.id) })) };
  });

  // ── bacheca avvisi della Home ──
  app.get('/api/avvisi', async (req) => {
    const ev = req.query.evento || null, amb = ['gare', 'formazione'].includes(req.query.ambito) ? req.query.ambito : 'gare';
    return (await pool.query(
      `select id, evento_id, titolo, testo, pubblico, ambito, created_at from avviso
        where ambito = $2 and (evento_id is null or evento_id = $1::uuid) order by created_at desc limit 20`, [ev, amb])).rows;
  });
  app.post('/api/avvisi', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {}, amb = b.ambito === 'formazione' ? 'formazione' : 'gare';
    if (b.evento_id) await verificaAccessoEvento(pool, req.utente, b.evento_id);
    else if (req.utente.per_evento && !req.utente.admin) throw httpErr(403, 'non puoi pubblicare avvisi globali');
    if (!b.titolo || !String(b.titolo).trim()) throw httpErr(400, 'titolo obbligatorio');
    return (await pool.query('insert into avviso (evento_id, titolo, testo, pubblico, ambito) values ($1,$2,$3,$4,$5) returning *',
      [b.evento_id || null, String(b.titolo).trim(), b.testo || null, b.pubblico === true && amb === 'gare', amb])).rows[0];
  });
  app.delete('/api/avvisi/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [a] } = await pool.query('select evento_id from avviso where id=$1', [req.params.id]);
    if (!a) throw httpErr(404, 'avviso inesistente');
    if (a.evento_id) await verificaAccessoEvento(pool, req.utente, a.evento_id);
    else if (req.utente.per_evento && !req.utente.admin) throw httpErr(403, 'non puoi eliminare avvisi globali');
    await pool.query('delete from avviso where id=$1', [req.params.id]); return { ok: true };
  });

  // ── eventi, squadre, scene ──
  app.get('/api/eventi', async (req) => {   // i giudici vedono solo la gara a cui sono legati (o quella attiva); organizzazione e admin tutte
    const org = RUOLI_ORG.includes(req.utente.ruolo);
    const righe = (await pool.query(
      `select id, codice, nome, tipo, luogo, to_char(data,'YYYY-MM-DD') as data, to_char(data_fine,'YYYY-MM-DD') as data_fine, attivo, archiviato, modalita, mappa_url, soglia_pct, mostra_punteggi, codice_gaia, corso_id, comitato, livello, regione, lat, lng, comune_istat, luogo_provincia, luogo_regione, modalita, segreteria_lat, segreteria_lng
         from evento where ($1 or id = $2 or id = any($3::uuid[]) or ($2::uuid is null and not cardinality($3::uuid[]) > 0 and attivo)) and ($1 or not archiviato)
        order by data desc nulls last`, [org, req.utente.evento_id, req.utente.eventi_ammessi])).rows;
    if (req.utente.ruolo === 'organizzazione' && req.utente.per_evento) return righe.filter((e) => req.utente.eventi_org.includes(e.id));
    if (req.utente.ruolo === 'organizzazione') { const v = []; for (const e of righe) { const acc = await accessoEvento(pool, req.utente, e); if (acc) v.push(acc === 'lettura' ? { ...e, invitato: true } : e); } righe.splice(0, righe.length, ...v); }
    if (!soloFormazione(req.utente)) return righe;                                // chi gestisce solo i corsi vede i corsi del suo ambito
    const prof = await profiloFormativo(pool, req.utente.id), out = [];
    for (const e of righe) if (await puoGestireEvento(pool, req.utente, e, prof)) out.push(e);
    return out;
  });
  // proprietario di un nuovo evento: chi non è admin crea per il proprio comitato (o, se approvatore, per la propria regione); l'admin sceglie
  const decidiEnte = async (req, b, tipo, comitatoGia) => {
    const TIPI_ENTE = ['comitato', 'regione', 'nazionale'];
    const mio = await enteUtente(pool, req.utente);
    if (req.utente.admin) {
      if (!b.livello) return { livello: null, comitato: null, regione: null };
      if (!TIPI_ENTE.includes(b.livello)) throw httpErr(400, 'proprietario non valido');
      const com = b.livello === 'comitato' ? (await canonico(pool, String(b.comitato || ''))).nome : null;
      if (b.livello === 'comitato' && !com) throw httpErr(400, 'indica il comitato proprietario');
      const reg = b.livello === 'regione' ? String(b.regione || '').trim() : (com ? await regioneDelComitato(pool, com) : null);
      if (b.livello === 'regione' && !reg) throw httpErr(400, 'indica la regione proprietaria');
      return { livello: b.livello, comitato: com, regione: reg };
    }
    if (soloFormazione(req.utente) || !mio.comitato) return { livello: null, comitato: null, regione: null };
    if (b.livello === 'regione' && èApprovatore(req.utente) && mio.regione) return { livello: 'regione', comitato: null, regione: mio.regione };
    return { livello: 'comitato', comitato: mio.comitato, regione: mio.regione };
  };
  app.put('/api/eventi/:id/ente', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    if (!req.utente.admin) throw httpErr(403, 'il proprietario lo cambia solo un amministratore');
    const ente = await decidiEnte(req, { livello: b.livello || null, comitato: b.comitato, regione: b.regione }, null, null);
    if (b.data_fine !== undefined && b.data_fine && Number.isNaN(Date.parse(b.data_fine))) throw httpErr(400, 'data di fine non valida');
    const { rows: [e] } = await pool.query(`update evento set livello=$2::text, comitato=case when $2::text is not null then $3::text else comitato end, regione=$4::text, data_fine=case when $5::boolean then nullif($6::text,'')::date else data_fine end, updated_at=now() where id=$1 returning *`,
      [req.params.id, ente.livello, ente.comitato, ente.regione, 'data_fine' in b, b.data_fine ?? '']);
    if (!e) throw httpErr(404, 'evento inesistente'); return e;
  });
  app.put('/api/eventi/:id/data-fine', { preHandler: soloOrg }, async (req) => {
    const d = req.body?.data_fine || null; if (d && Number.isNaN(Date.parse(d))) throw httpErr(400, 'data di fine non valida');
    const { rows: [e] } = await pool.query(`update evento set data_fine=$2::date, updated_at=now() where id=$1 returning id, to_char(data_fine,'YYYY-MM-DD') as data_fine`, [req.params.id, d]);
    if (!e) throw httpErr(404, 'evento inesistente'); return e;
  });
  // coordinate: la città si ricava dal luogo, la segreteria si scrive a mano («44.4056, 10.5912», come la copia Google Maps)
  app.put('/api/eventi/:id/posizione', { preHandler: soloOrg }, async (req) => {
    const b = req.body || {};
    const { rows: [att] } = await pool.query('select id, luogo from evento where id=$1', [req.params.id]); if (!att) throw httpErr(404, 'evento inesistente');
    if ('segreteria' in b) {
      const c = b.segreteria ? leggiCoordinate(b.segreteria) : { lat: null, lng: null };
      if (!c) throw httpErr(400, 'coordinate non valide: scrivi latitudine e longitudine, per esempio 44.4056, 10.5912');
      await pool.query('update evento set segreteria_lat=$2, segreteria_lng=$3, updated_at=now() where id=$1', [att.id, c.lat, c.lng]);
    }
    if (b.comune || b.ricava) {
      const c = b.comune ? comunePerIstat(b.comune) : comuneDaLuogo(att.luogo);
      if (!c) throw httpErr(404, b.comune ? 'comune inesistente' : att.luogo ? `non riconosco «${att.luogo}» tra i comuni: scegli regione, provincia e comune dall'elenco` : 'scegli prima il comune dell\'evento');
      await pool.query('update evento set luogo=$2, comune_istat=$3, luogo_provincia=$4, luogo_regione=$5, lat=$6, lng=$7, updated_at=now() where id=$1', [att.id, etichettaLuogo(c), c.istat, c.provincia, c.regione, c.lat, c.lng]);
    }
    return (await pool.query('select id, luogo, lat, lng, comune_istat, luogo_provincia, luogo_regione, segreteria_lat, segreteria_lng from evento where id=$1', [att.id])).rows[0];
  });
  // una volta sola per gli eventi già caricati: riconosce il comune dal luogo scritto a mano e ne ricava le coordinate
  app.post('/api/eventi/ricava-coordinate', { preHandler: soloAdmin }, async () => {
    const { rows } = await pool.query(`select id, nome, luogo from evento where comune_istat is null and coalesce(trim(luogo),'') <> '' and tipo in ('gara','olimpiadi','corso_giudici') and not archiviato`);
    const fatti = [], mancanti = [];
    for (const e of rows) {
      const c = comuneDaLuogo(e.luogo);
      if (c) { await pool.query('update evento set luogo=$2, comune_istat=$3, luogo_provincia=$4, luogo_regione=$5, lat=$6, lng=$7 where id=$1', [e.id, etichettaLuogo(c), c.istat, c.provincia, c.regione, c.lat, c.lng]); fatti.push(`${e.nome} → ${etichettaLuogo(c)}`); } else mancanti.push(`${e.nome} (${e.luogo})`);
    }
    return { fatti, mancanti };
  });
  // elenco dei comuni per i selettori (regione → provincia → comune, con ricerca)
  app.get('/api/comuni/regioni', async () => regioniComuni());
  app.get('/api/comuni/province', async (req) => provinceComuni(req.query?.regione || ''));
  app.get('/api/comuni', async (req) => cercaComuni({ regione: req.query?.regione, provincia: req.query?.provincia, q: req.query?.q }, Math.min(Number(req.query?.limite) || 60, 300)));
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
    const didattico = ['allenamento', 'corso', 'esame', 'megacode', 'corso_giudici'].includes(tipo);
    const ente = await decidiEnte(req, b, tipo, comitato);
    if (ente.livello === 'comitato' && !req.utente.admin && ['gara', 'olimpiadi', 'corso_giudici'].includes(tipo)) throw httpErr(403, 'le gare, le Olimpiadi e i corsi giudici li organizza la regione: un comitato crea allenamenti');
    const com = b.comune ? comunePerIstat(b.comune) : null;
    if (b.comune && !com) throw httpErr(400, 'comune inesistente');
    return (await pool.query(
      `insert into evento (codice, nome, tipo, titolo_stampa, luogo, data, data_fine, mostra_punteggi, soglia_pct, codice_gaia, corso_id, comitato, livello, regione, comune_istat, luogo_provincia, luogo_regione, lat, lng) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,nullif(trim($10),''),$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
      [b.codice, b.nome, tipo, b.titolo_stampa, com ? etichettaLuogo(com) : b.luogo, b.data, b.data_fine || null, didattico, tipo === 'esame' ? 75 : null, b.codice_gaia ?? '', b.corso_id || null, ente.comitato ?? comitato, ente.livello, ente.regione, com?.istat ?? null, com?.provincia ?? null, com?.regione ?? null, com?.lat ?? null, com?.lng ?? null])).rows[0];
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
    (await pool.query('select id, numero, nome, comitato, attiva, partenza_scena_id from squadra where evento_id=$1 order by numero', [req.params.id])).rows);
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
      `select sc.id, sc.codice, sc.titolo, sc.indirizzo, sc.lat, sc.lng, sc.canovaccio_id, sc.sosta,
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
  // ── allenamento del comitato: comitati invitati (consultano l'allenamento, non lo modificano) ──
  const soloAllenamento = async (id) => { const { rows: [e] } = await pool.query('select id, tipo from evento where id=$1', [id]); if (!e) throw httpErr(404, 'evento inesistente'); if (e.tipo !== 'allenamento') throw httpErr(400, 'solo gli allenamenti si aprono ad altri comitati'); };
  app.get('/api/eventi/:id/comitati-invitati', { preHandler: soloOrg }, async (req) => (await pool.query('select comitato from evento_comitato_invitato where evento_id=$1 order by comitato', [req.params.id])).rows.map((r) => r.comitato));
  app.put('/api/eventi/:id/comitati-invitati', { preHandler: soloOrg }, async (req) => {
    await soloAllenamento(req.params.id);
    const lista = Array.isArray(req.body?.comitati) ? req.body.comitati : null; if (!lista || lista.length > 60) throw httpErr(400, 'elenco comitati non valido (max 60)');
    const nomi = []; for (const t of lista) { const c = (await canonico(pool, String(t))).comitato; if (!c) throw httpErr(400, `«${t}» non è un comitato dell'elenco ufficiale`); if (!nomi.includes(c.nome)) nomi.push(c.nome); }
    await inTransazione(pool, async (db) => { await db.query('delete from evento_comitato_invitato where evento_id=$1', [req.params.id]);
      for (const n of nomi) await db.query('insert into evento_comitato_invitato (evento_id, comitato, invitato_da) values ($1,$2,$3)', [req.params.id, n, req.utente.id]); });
    return nomi;
  });
  // ── doppioni in libreria ──
  app.get('/api/libreria/doppioni', { preHandler: soloOrg }, async (req) => trovaDoppioni(pool, req.utente));
  app.post('/api/libreria/doppioni/ignora', { preHandler: soloOrg }, async (req) => ignora(pool, req.utente, req.body?.a, req.body?.b));
  // ── revisioni delle schede ──
  app.get('/api/libreria/patologie/:id/revisioni', { preHandler: soloOrg }, async (req) => revisioni(pool, req.utente, req.params.id));
  app.get('/api/libreria/confronta', { preHandler: soloOrg }, async (req) => confronta(pool, req.utente, req.query.a, req.query.b));
  app.get('/api/libreria/raggruppamenti', { preHandler: soloOrg }, async (req) => proposteRaggruppamento(pool, req.utente));
  app.post('/api/libreria/raggruppamenti', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => raggruppa(db, req.utente, req.body?.base, req.body?.revisione, { allinea: req.body?.allinea === true })));
  app.post('/api/schede/:id/revisione', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => salvaRevisioneDaScena(db, req.utente, req.params.id, req.body || {})));
  app.post('/api/libreria/patologie/:id/unisci', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => unisci(db, req.utente, req.params.id, req.body?.in)));
  // ── dal comitato alla regione: proposte, approvazione, catalogo e condivisione ──
  const regioneMia = async (req) => (await enteUtente(pool, req.utente)).regione;
  const soloApprovatore = async (req) => { if (!èApprovatore(req.utente)) throw httpErr(403, 'serve il ruolo di approvatore'); };
  app.post('/api/scene/:id/promozione', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => proponi(db, req.utente, { scenaId: req.params.id }, req.body || {})));
  app.post('/api/libreria/patologie/:id/proponi', { preHandler: soloOrg }, async (req) => { await controllaScheda(pool, req.utente, req.params.id, { modifica: true });
    return inTransazione(pool, (db) => proponi(db, req.utente, { patologiaId: req.params.id }, req.body || {})); });
  app.get('/api/promozioni', { preHandler: soloOrg }, async (req) => {
    const appr = èApprovatore(req.utente), reg = await regioneMia(req);
    return (await pool.query(
      `select p.id, p.tipo, p.livello, p.stato, p.automatica, p.nota, p.motivo, p.esito, p.controllo, p.regione, p.comitato, p.created_at, p.deciso_il, s.codice as scena, s.titolo as scena_titolo, e.nome as evento, pt.nome as scheda,
              u.nome as proponente, d.nome as deciso_da, (select count(*)::int from scena_scheda k where k.scena_id=s.id and not k.is_master) as schede
         from promozione p left join scena s on s.id=p.scena_id left join evento e on e.id=s.evento_id left join patologia pt on pt.id=p.patologia_id left join utente u on u.id=p.proposta_da left join utente d on d.id=p.deciso_da
        where ($1::boolean and ($2::boolean or p.regione = $3::text) or p.proposta_da=$4::uuid) and (p.stato='in_attesa' or p.created_at > now() - interval '90 days') order by (p.stato='in_attesa') desc, p.created_at desc limit 100`,
      [appr, !!req.utente.admin, reg, req.utente.id])).rows;
  });
  app.post('/api/promozioni/:id/approva', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => approva(db, req.params.id, req.utente, req.body || {})));
  app.post('/api/promozioni/:id/rifiuta', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => rifiuta(db, req.params.id, req.utente, req.body?.motivo)));
  app.get('/api/regioni', { preHandler: soloOrg }, async () => tutteLeRegioni(pool));
  // catalogo della mia regione e materiale ricevuto da altre regioni (l'approvatore vede tutto, gli altri solo ciò che è reso disponibile ai comitati)
  app.get('/api/catalogo', { preHandler: soloOrg }, async (req) => {
    const reg = await regioneMia(req), appr = èApprovatore(req.utente), adm = !!req.utente.admin;
    const { rows } = await pool.query(
      `select c.tipo, c.risorsa_id as id, coalesce(p.nome, s.titolo) as nome, coalesce(p.regione, s.regione) as proprietaria, c.regione as per, c.comitati, c.origine,
              (select coalesce(array_agg(x.regione order by x.regione), '{}') from condivisione x where x.tipo=c.tipo and x.risorsa_id=c.risorsa_id and not x.origine) as con_regioni
         from condivisione c left join patologia p on c.tipo='patologia' and p.id=c.risorsa_id left join scena s on c.tipo='scena' and s.id=c.risorsa_id
        where ($1::boolean or (c.regione = $2::text and ($3::boolean or c.comitati))) and coalesce(p.id, s.id) is not null order by nome`, [adm, reg, appr]);
    return { regione: reg, approvatore: appr, voci: rows };
  });
  const regioneProprietaria = async (tipo, id) => (await pool.query(tipo === 'scena' ? 'select regione from scena where id=$1' : 'select regione from patologia where id=$1', [id])).rows[0]?.regione ?? null;
  app.put('/api/condivisione/:tipo/:id', { preHandler: [soloOrg, soloApprovatore] }, async (req) => {
    const { tipo, id } = req.params; if (!['scena', 'patologia'].includes(tipo)) throw httpErr(400, 'tipo non valido');
    const prop = await regioneProprietaria(tipo, id); if (!prop) throw httpErr(404, 'non è materiale di una regione');
    if (!req.utente.admin && prop !== await regioneMia(req)) throw httpErr(403, 'è materiale di un\'altra regione');
    const b = req.body || {}; if (b.regioni && b.regioni !== 'tutte' && !Array.isArray(b.regioni)) throw httpErr(400, 'elenco regioni non valido');
    await inTransazione(pool, (db) => impostaCondivisione(db, tipo, id, prop, { comitati: b.comitati, regioni: b.regioni }));
    return { ok: true };
  });
  app.put('/api/condivisione/:tipo/:id/ricevuta', { preHandler: [soloOrg, soloApprovatore] }, async (req) => {   // la regione ricevente lo rende disponibile ai propri comitati
    const reg = await regioneMia(req); if (!reg) throw httpErr(400, 'la tua regione non è nota');
    const { rowCount } = await pool.query('update condivisione set comitati=$4 where tipo=$1 and risorsa_id=$2 and regione=$3 and not origine', [req.params.tipo, req.params.id, reg, !!req.body?.comitati]);
    if (!rowCount) throw httpErr(404, 'non è stato condiviso con la tua regione'); return { ok: true };
  });
  app.get('/api/scene-condivise', { preHandler: soloOrg }, async (req) => {
    const reg = await regioneMia(req), appr = èApprovatore(req.utente), adm = !!req.utente.admin;
    return (await pool.query(
      `select s.id, s.codice, s.titolo, s.regione as condivisa, e.nome as evento, e.codice as evento_codice, e.tipo as evento_tipo, to_char(e.data,'YYYY') as anno, (select count(*)::int from scena_scheda k where k.scena_id=s.id) as schede
         from scena s join evento e on e.id=s.evento_id where s.regione is not null and ($1::boolean or exists (select 1 from condivisione c where c.tipo='scena' and c.risorsa_id=s.id and c.regione=$2::text and ($3::boolean or c.comitati))) order by s.titolo`, [adm, reg, appr])).rows;
  });
  app.post('/api/scene-condivise/:id/copia', { preHandler: soloOrg }, async (req) => {
    const { eventoDestId, nuovoCodice } = req.body || {};
    if (!eventoDestId || !CODICE_SCENA.test(nuovoCodice || '')) throw httpErr(400, 'scegli l\'evento e un codice scena (1-3 caratteri maiuscoli o cifre)');
    await verificaAccessoEvento(pool, req.utente, eventoDestId);
    const reg = await regioneMia(req), appr = èApprovatore(req.utente);
    const { rows: [s] } = await pool.query(`select s.id from scena s where s.id=$1 and s.regione is not null and ($2::boolean or exists (select 1 from condivisione c where c.tipo='scena' and c.risorsa_id=s.id and c.regione=$3::text and ($4::boolean or c.comitati)))`, [req.params.id, !!req.utente.admin, reg, appr]);
    if (!s) throw httpErr(404, 'scena non disponibile');
    if (req.utente.per_evento && !req.utente.eventi_org.includes(String(eventoDestId).toLowerCase())) throw httpErr(403, 'gara non assegnata');
    return inTransazione(pool, (db) => duplicaScena(db, { scenaId: req.params.id, eventoDestId, nuovoCodice }));
  });
  // collega ai canovacci le scene dell'evento che non ne hanno uno: stessa lettera, versione Gara oppure Olimpiadi in base al tipo di evento
  app.post('/api/eventi/:id/collega-canovacci', { preHandler: soloOrg }, async (req) => {
    const { rows: [e] } = await pool.query('select tipo, codice from evento where id=$1', [req.params.id]); if (!e) throw httpErr(404, 'evento inesistente');
    const ver = e.tipo === 'olimpiadi' ? 'olimpiadi' : e.tipo === 'megacode' ? 'megacode' : 'gara';
    // stessa lettera e stesso codice gara; in mancanza, i canovacci ancora senza codice
    const r = await pool.query(`update scena s set canovaccio_id = x.cid from (
        select distinct on (s2.id) s2.id as sid, c.id as cid from scena s2 join canovaccio c on c.codice = s2.codice and c.versione = $2 and (c.gara_codice = $3 or c.gara_codice is null)
         where s2.evento_id=$1 and s2.canovaccio_id is null order by s2.id, (c.gara_codice = $3) desc nulls last) x where s.id = x.sid returning s.codice`, [req.params.id, ver, e.codice]);
    return { collegate: r.rows.map((x) => x.codice) };
  });
  // ── canovacci: descrizione completa delle scene (briefing, pazienti, triage, logistica) ──
  app.post('/api/import/canovacci', { preHandler: soloOrg, bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (!files.length || files.length > 30) throw httpErr(400, 'carica da 1 a 30 file .docx');
    const esiti = [];
    for (const f of files) {
      try { esiti.push({ file: f.nome, ...(await importaCanovaccio(pool, Buffer.from(String(f.dati || ''), 'base64'), f.nome || '', req.body?.gara_codice)) }); }
      catch (e) { esiti.push({ file: f.nome, errore: e.statusCode && e.statusCode < 500 ? e.message : 'file non leggibile' }); }
    }
    return { esiti };
  });
  app.get('/api/canovacci', { preHandler: soloOrg }, async () => (await pool.query(
    `select c.id, c.codice, c.versione, c.titolo, c.tempo_min, c.fabbisogno, c.gara_codice, jsonb_array_length(c.dati->'pazienti') as pazienti, c.updated_at,
            (select count(*)::int from scena s where s.canovaccio_id = c.id) as scene,
            (select coalesce(array_agg(distinct e.codice order by e.codice), '{}') from scena s join evento e on e.id = s.evento_id where s.canovaccio_id = c.id) as usato_in
       from canovaccio c order by c.codice, c.versione`)).rows);
  app.get('/api/canovacci/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [c] } = await pool.query('select * from canovaccio where id=$1', [req.params.id]);
    if (!c) throw httpErr(404, 'canovaccio inesistente'); return c;
  });
  app.get('/api/canovacci/:id/canovaccio.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const { rows: [c] } = await pool.query('select * from canovaccio where id=$1', [req.params.id]);
    if (!c) throw httpErr(404, 'canovaccio inesistente');
    const doc = (c.versione === 'megacode' ? creaScenario : creaCanovaccio)(c); const chunks = []; doc.on('data', (x) => chunks.push(x)); const fine = new Promise((r) => doc.on('end', r)); doc.end(); await fine;
    return reply.type('application/pdf').header('Content-Disposition', `inline; filename="canovaccio-${c.codice}-${c.versione}.pdf"`).send(Buffer.concat(chunks));
  });
  // nuovo canovaccio da modulo (Gara, Olimpiadi o scenario di Mega Code) e modifica del suo contenuto
  const salvaCanovaccio = async (id, versione, b) => {
    const h = validaIntestazione(b, versione), dati = normalizzaDati(versione, b.dati);
    try {
      if (id) {
        const { rows: [vecchio] } = await pool.query('select dati from canovaccio where id=$1', [id]); if (!vecchio) throw httpErr(404, 'canovaccio inesistente');
        if (versione !== 'megacode') { dati.pazienti = vecchio.dati?.pazienti ?? []; dati.triage = vecchio.dati?.triage ?? []; }
        const r = await pool.query('update canovaccio set codice=$2, titolo=$3, tempo_min=$4, gara_codice=$5, dati=$6, updated_at=now() where id=$1 returning id', [id, h.codice, h.titolo, h.tempo, h.gara, dati]);
        return { id: r.rows[0].id };
      }
      const r = await pool.query('insert into canovaccio (codice, versione, titolo, tempo_min, dati, fabbisogno, gara_codice) values ($1,$2,$3,$4,$5,$6,$7) returning id', [h.codice, versione, h.titolo, h.tempo, dati, {}, h.gara]);
      return { id: r.rows[0].id };
    } catch (e) { if (e.code === '23505') throw httpErr(409, 'esiste già un canovaccio con questa lettera, questo tipo e questo codice evento'); throw e; }
  };
  // i quattro scenari di esempio (Spinale, Scoop e casco, XT, Sospetto ictus): bozza modificabile per iniziare un Mega Code
  app.post('/api/canovacci/esempi-megacode', { preHandler: soloOrg }, async () => {
    const esempi = JSON.parse(fs.readFileSync(new URL('./dati/megacode-esempio.json', import.meta.url), 'utf8')); let creati = 0;
    for (const e of esempi) {
      const r = await pool.query(`insert into canovaccio (codice, versione, titolo, tempo_min, dati, fabbisogno, gara_codice) values ($1,'megacode',$2,$3,$4,'{}','MC-ESEMPIO') on conflict ((coalesce(gara_codice, '')), codice, versione) do nothing`,
        [e.codice, e.titolo, e.tempo_min ?? null, normalizzaDati('megacode', e.dati)]); creati += r.rowCount;
    }
    return { creati };
  });
  app.post('/api/canovacci', { preHandler: soloOrg }, async (req) => salvaCanovaccio(null, req.body?.versione, req.body || {}));
  app.put('/api/canovacci/:id', { preHandler: soloOrg }, async (req) => {
    const { rows: [c] } = await pool.query('select versione from canovaccio where id=$1', [req.params.id]); if (!c) throw httpErr(404, 'canovaccio inesistente');
    if (c.versione !== 'megacode') throw httpErr(400, 'i canovacci di gara e olimpiadi importati da file non si modificano da qui');
    return salvaCanovaccio(req.params.id, c.versione, req.body || {});
  });
  // il codice della gara si scrive a mano oppure si ricava dalla gara in cui il canovaccio è già usato
  app.patch('/api/canovacci/:id', { preHandler: soloOrg }, async (req) => {
    const g = String(req.body?.gara_codice ?? '').trim().toUpperCase() || null;
    if (g && !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(g)) throw httpErr(400, 'codice gara: lettere, numeri e trattini (es. GPSER-2027)');
    try { const r = await pool.query('update canovaccio set gara_codice=$2, updated_at=now() where id=$1 returning id', [req.params.id, g]); if (!r.rowCount) throw httpErr(404, 'canovaccio inesistente'); }
    catch (e) { if (e.code === '23505') throw httpErr(409, 'esiste già un canovaccio di questa scena con quel codice gara'); throw e; }
    return { ok: true, gara_codice: g };
  });
  app.post('/api/canovacci/codici-mancanti', { preHandler: soloOrg }, async () => {
    const { rows } = await pool.query(`select c.id, array_agg(distinct e.codice) as cod from canovaccio c join scena s on s.canovaccio_id=c.id join evento e on e.id=s.evento_id where c.gara_codice is null group by c.id having count(distinct e.codice) = 1`);
    let n = 0;
    for (const r of rows) { try { await pool.query('update canovaccio set gara_codice=$2 where id=$1', [r.id, r.cod[0]]); n++; } catch (e) { if (e.code !== '23505') throw e; } }
    return { compilati: n };
  });
  app.delete('/api/canovacci/:id', { preHandler: soloOrg }, async (req) => { await pool.query('delete from canovaccio where id=$1', [req.params.id]); return { ok: true }; });
  app.post('/api/eventi/:id/scene', { preHandler: soloOrg }, async (req) => {
    const { codice, titolo, ordine, sosta } = req.body || {};
    if (!/^[A-Z0-9]{1,3}$/.test(codice || '')) throw httpErr(400, 'codice scena: 1-3 caratteri maiuscoli o cifre');
    if (!titolo || titolo.length > 120) throw httpErr(400, 'titolo obbligatorio (max 120 caratteri)');
    return creaScena(pool, { eventoId: req.params.id, codice, titolo, ordine, sosta: !!sosta });
  });
  app.post('/api/scene/:id/duplica', { preHandler: soloOrg }, async (req) => {
    const { eventoDestId, nuovoCodice } = req.body || {};
    await verificaAccessoEvento(pool, req.utente, eventoDestId);
    return inTransazione(pool, (db) => duplicaScena(db, { scenaId: req.params.id, eventoDestId, nuovoCodice }));
  });
  app.post('/api/scene/:id/elenco-pazienti', { preHandler: soloOrg }, async (req) => inTransazione(pool, (db) => aggiornaElencoPazienti(db, req.params.id)));
  app.post('/api/scene/:id/schede', { preHandler: soloOrg }, async (req) => {
    const { slot, patologiaId, simulatore, parametri, titolo, overrides } = req.body || {};
    await controllaScheda(pool, req.utente, patologiaId, { modifica: false });
    return inTransazione(pool, (db) => aggiungiSchedaDaPatologia(db, { scenaId: req.params.id, slot, patologiaId, simulatore, parametri, titolo, overrides }));
  });
  app.get('/api/schede/:id', async (req) => {
    const { rows: [s] } = await pool.query('select * from scena_scheda where id=$1', [req.params.id]);
    if (!s) throw httpErr(404, 'scheda inesistente');
    await accessoScheda(req.utente, s.id);
    const voci = (await pool.query('select * from scena_scheda_voce where scheda_id=$1 order by ordine', [s.id])).rows;
    const { rows: [ve] } = await pool.query('select e.tipo, e.soglia_pct, e.mostra_punteggi from scena sc join evento e on e.id = sc.evento_id where sc.id=$1', [s.scena_id]);
    s.evento = ve;
    const nProprie = voci.filter((v) => !v.blocco_id).length;       // le skill incorporate hanno fasce proprie
    if (!s.fasce && SKILL_AUTO.includes(ve?.tipo) && nProprie) s.fasce = fasceAuto(nProprie);
    const LIVELLI = ['mb', 'be', 'su', 'in', 'ne'];
    s.voci = voci.map((v) => {
      const consentiti = LIVELLI.filter((l) => v[l] !== null).map((l) => l.toUpperCase());
      if (!RUOLI_ORG.includes(req.utente.ruolo)) {      // chi inserisce i dati non deve conoscere il valore dei punti (salvo esami, corsi e allenamenti)
        const base = { id: v.id, scheda_id: v.scheda_id, ordine: v.ordine, sezione: v.sezione, testo: v.testo, consentiti, blocco_id: v.blocco_id, blocco_nome: v.blocco_nome };
        if (ve?.mostra_punteggi) base.punti = Object.fromEntries(LIVELLI.filter((l) => v[l] !== null).map((l) => [l.toUpperCase(), v[l]]));
        return base;
      }
      return { ...v, consentiti };
    });
    // skill incorporate: fasce proprie (calcolate sulle loro voci) ed errori gravi
    const bl = new Map();
    for (const v of voci) if (v.blocco_id) bl.set(v.blocco_id, { id: v.blocco_id, nome: v.blocco_nome, n: (bl.get(v.blocco_id)?.n ?? 0) + 1 });
    if (bl.size) {
      const { rows: pg } = await pool.query('select id, errori_gravi, fasce from patologia where id = any($1::uuid[])', [[...bl.keys()]]);
      s.blocchi = [...bl.values()].map((b) => { const p = pg.find((x) => x.id === b.id); return { ...b, fasce: p?.fasce?.length ? p.fasce : fasceAuto(b.n), errori_gravi: p?.errori_gravi ?? [] }; });
    }
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
         from scena_scheda_voce v left join risposta r on r.voce_id = v.id and r.compilazione_id = $2 where v.scheda_id=$1 and v.blocco_id is null order by v.ordine`, [s.id, c?.id ?? null]);
    const punti = voci.reduce((a, v) => a + (v.livello ? Number(v.punti) : 0), 0), massimo = voci.reduce((a, v) => a + Number(v.max), 0);
    const pdf = await generaEsitoPdf({ evento: e, scheda: s.titolo, candidato: q, giudice: c?.giudice, voci, punti, massimo, soglia: e.soglia_pct ? Number(e.soglia_pct) : null, fasce: s.fasce ?? (SKILL_AUTO.includes(e.tipo) && voci.length ? fasceAuto(voci.length) : null) });
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

  // ── modifica della scheda di una scena (è una copia: la libreria non cambia) ──
  const COLONNE_LIV = ['mb', 'be', 'su', 'in', 'ne'];

  const schedaValutata = async (db, id) => (await db.query('select 1 from compilazione where scheda_id=$1 limit 1', [id])).rowCount > 0;
  app.get('/api/schede/:id/anteprima.pdf', { preHandler: soloOrg }, async (req, reply) => {
    const { rows: [k] } = await pool.query(`select s.titolo, s.simulatore, s.is_master, s.gravita, s.parametri, sc.codice, sc.titolo as scena_titolo, e.nome as ev_nome, e.titolo_stampa, e.luogo
      from scena_scheda s join scena sc on sc.id=s.scena_id join evento e on e.id=sc.evento_id where s.id=$1`, [req.params.id]);
    if (!k) throw httpErr(404, 'scheda inesistente');
    const { rows: voci } = await pool.query(`select ordine as id, sezione, testo, is_sep, mb, be, su, "in", ne from scena_scheda_voce where scheda_id=$1 and blocco_id is null order by ordine`, [req.params.id]);
    const doc = creaDocumento(); const chunks = []; doc.on('data', (c) => chunks.push(c)); const fine = new Promise((r) => doc.on('end', r));
    const { rows: [pk] } = await pool.query('select p.tipologie, p.categoria, p.fasce, p.errori_gravi, p.sigla from scena_scheda s join patologia p on p.id=s.patologia_id where s.id=$1', [req.params.id]);
    if (pk && èSkill(pk)) { disegnaSkill(doc, { titolo: k.titolo, modello: `SKILL ${pk.sigla}`, voci, fasce: pk.fasce, erroriGravi: pk.errori_gravi }); doc.end(); await fine;
      return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="anteprima.pdf"').send(Buffer.concat(chunks)); }
    disegnaScheda(doc, { evento: { nome: k.ev_nome, titolo_stampa: k.titolo_stampa || k.ev_nome, luogo: k.luogo || '', data_txt: null }, squadra: { numero: 0, nome: 'Anteprima' },
      scena: { codice: k.codice, titolo: k.scena_titolo }, scheda: { simulatore: k.simulatore, titolo: k.titolo, is_master: k.is_master, gravita: k.gravita, parametri: k.parametri || {} }, voci, compilazione: null, risposte: new Map(), vuota: true });
    doc.end(); await fine;
    return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="anteprima.pdf"').send(Buffer.concat(chunks));
  });
  // nuova voce (dopo la voce indicata, o in coda); i livelli arrivano dalla scala scelta oppure dal corpo
  app.post('/api/schede/:id/voci', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const b = req.body || {}, id = req.params.id;
    const { rows: [sch] } = await db.query('select id from scena_scheda where id=$1 for update', [id]); if (!sch) throw httpErr(404, 'scheda inesistente');
    if (await schedaValutata(db, id)) throw httpErr(409, 'la scheda ha già delle valutazioni: non si possono aggiungere voci');
    const testo = String(b.testo || '').trim(), sezione = String(b.sezione || '').trim();
    if (!testo || !sezione) throw httpErr(400, 'servono sezione e testo della voce');
    let liv = {}, scala = 'personalizzata';
    if (b.scala) { const { rows: [sp] } = await db.query('select * from scala_punteggio where codice=$1', [b.scala]); if (!sp) throw httpErr(400, 'scala inesistente'); scala = sp.codice; for (const l of COLONNE_LIV) liv[l] = sp[l]; }
    else for (const l of COLONNE_LIV) { if (b[l] !== undefined && b[l] !== null && !Number.isInteger(b[l])) throw httpErr(400, `${l}: numero intero o null`); liv[l] = b[l] ?? null; }
    if (COLONNE_LIV.every((l) => liv[l] === null)) throw httpErr(400, 'almeno un livello deve essere selezionabile');
    let ordine;
    if (b.dopo === undefined || b.dopo === null) ordine = (await db.query('select coalesce(max(ordine),0)+1 as o from scena_scheda_voce where scheda_id=$1', [id])).rows[0].o;
    else {
      ordine = Number(b.dopo) + 1;
      await db.query('update scena_scheda_voce set ordine = ordine + 100000 where scheda_id=$1 and ordine >= $2', [id, ordine]);
      await db.query('update scena_scheda_voce set ordine = ordine - 99999 where scheda_id=$1 and ordine >= $2', [id, ordine + 100000]);
    }
    const { rows: [r] } = await db.query(`insert into scena_scheda_voce (scheda_id, ordine, sezione, testo, scala, mb, be, su, "in", ne, is_sep) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [id, ordine, sezione, testo, scala, liv.mb, liv.be, liv.su, liv.in, liv.ne, !!b.is_sep]);
    await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'aggiungi_voce','scena_scheda_voce',$2,$3)`, [req.utente.id, r.id, JSON.stringify({ dopo: r })]);
    return r;
  }));
  app.delete('/api/schede/:id/voci/:ordine', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    const { rows: [v] } = await db.query('select * from scena_scheda_voce where scheda_id=$1 and ordine=$2 for update', [req.params.id, req.params.ordine]);
    if (!v) throw httpErr(404, 'voce inesistente');
    if ((await db.query('select 1 from risposta where voce_id=$1 limit 1', [v.id])).rowCount) throw httpErr(409, 'la voce è già stata usata in valutazioni: non si può eliminare');
    await db.query('delete from scena_scheda_voce where id=$1', [v.id]);
    await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'elimina_voce','scena_scheda_voce',$2,$3)`, [req.utente.id, v.id, JSON.stringify({ prima: v })]);
    return { ok: true };
  }));
  app.put('/api/schede/:id/sezione', { preHandler: soloOrg }, async (req) => {
    const { da, a } = req.body || {}; if (!da || !String(a || '').trim()) throw httpErr(400, 'indica la sezione e il nuovo nome');
    const { rowCount } = await pool.query('update scena_scheda_voce set sezione=$3 where scheda_id=$1 and sezione=$2', [req.params.id, da, String(a).trim()]);
    if (!rowCount) throw httpErr(404, 'sezione inesistente'); return { ok: true };
  });

  // ── libreria ──
  app.get('/api/libreria/scale', { preHandler: soloOrg }, async () => (await pool.query('select * from scala_punteggio order by codice')).rows);
  app.get('/api/libreria/voci', { preHandler: soloOrg }, async (req) => (await pool.query(
    `select * from voce where $1::text is null or testo ilike '%'||$1||'%' order by testo limit 200`, [req.query.q ?? null])).rows);
  app.get('/api/libreria/macro', { preHandler: soloOrg }, async () => (await pool.query('select * from macro_categoria order by priorita')).rows);
  app.get('/api/libreria/patologie', { preHandler: soloOrg }, async (req) => {
    // generale per tutti; le schede dei comitati solo se la direzione le chiede (?comitati=1) o per il proprio comitato
    const tutte = haSchede(req.utente) && req.query.comitati === '1';
    const mio = haSchede(req.utente) ? null : await comitatoDi(pool, req.utente);
    return (await pool.query(
    `select p.*, (select count(*) from patologia_voce where patologia_id=p.id) as voci,
       (select nome from utente where id = p.creata_da) as autore,
       (select count(*)::int from patologia q where q.gruppo_id = p.gruppo_id) as revisioni,
       (select coalesce(jsonb_agg(jsonb_build_object('evento', x.nome, 'codice', x.codice, 'luogo', x.luogo, 'data', to_char(x.data, 'YYYY-MM-DD')) order by x.data desc nulls last), '[]'::jsonb)
          from (select distinct e.id, e.nome, e.codice, e.luogo, e.data from scena_scheda ss join scena s on s.id = ss.scena_id join evento e on e.id = s.evento_id where ss.patologia_id = p.id) x) as usi
       from patologia p where (p.comitato is null or $1::boolean or lower(trim(p.comitato)) = lower(trim($2::text))) and (not p.bozza or p.creata_da = $3::uuid)
         and ($7::boolean or p.revisione = (select max(revisione) from patologia q where q.gruppo_id = p.gruppo_id))
         and (p.regione is null or $4::boolean or exists (select 1 from condivisione c where c.tipo='patologia' and c.risorsa_id=p.id and c.regione=$5::text and ($6::boolean or c.comitati))) order by nome`,
      [tutte, mio, req.utente.id, !!req.utente.admin, (await enteUtente(pool, req.utente)).regione, èApprovatore(req.utente), req.query.tutte === '1'])).rows;
  });
  app.get('/api/libreria/patologie/:id', { preHandler: soloOrg }, async (req) => { await controllaScheda(pool, req.utente, req.params.id, { modifica: false }); return (await pool.query(
    `select pv.ordine, pv.sezione, v.testo, sp.codice as scala, pv.is_sep from patologia_voce pv
       join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id
      where pv.patologia_id=$1 order by pv.ordine`, [req.params.id])).rows; });
  // skill incorporate in una scheda composta: dopo quale voce si aprono
  app.get('/api/libreria/patologie/:id/skill', { preHandler: soloOrg }, async (req) => {
    await controllaScheda(pool, req.utente, req.params.id, { modifica: false });
    return (await pool.query(`select ps.dopo_ordine, ps.skill_id, p.nome, p.sigla, (select count(*)::int from patologia_voce where patologia_id=p.id) as voci
      from patologia_skill ps join patologia p on p.id=ps.skill_id where ps.patologia_id=$1 order by ps.dopo_ordine, p.nome`, [req.params.id])).rows;
  });
  app.put('/api/libreria/patologie/:id/skill', { preHandler: soloOrg }, async (req) => {
    await controllaScheda(pool, req.utente, req.params.id, { modifica: true });
    const l = Array.isArray(req.body?.skill) ? req.body.skill : null;
    if (!l || l.length > 20) throw httpErr(400, 'elenco delle skill non valido');
    const { rows: [{ n }] } = await pool.query('select count(*)::int n from patologia_voce where patologia_id=$1', [req.params.id]);
    const visti = new Set();
    for (const x of l) {
      if (!/^[0-9a-f-]{36}$/i.test(x?.skill_id || '') || !Number.isInteger(x.dopo_ordine) || x.dopo_ordine < 0 || x.dopo_ordine > n) throw httpErr(400, 'skill o posizione non valida');
      if (x.skill_id === req.params.id) throw httpErr(400, 'una scheda non può incorporare se stessa');
      if (visti.has(x.skill_id)) throw httpErr(400, 'la stessa skill non può comparire due volte: il suo punteggio è uno solo');
      visti.add(x.skill_id);
      const { rows: [sk] } = await pool.query('select tipologie, categoria from patologia where id=$1', [x.skill_id]);
      if (!sk) throw httpErr(404, 'skill inesistente');
      if (!èSkill(sk)) throw httpErr(400, 'si possono incorporare solo schede di tipo skill');
      if ((await pool.query('select 1 from patologia_skill where patologia_id=$1', [x.skill_id])).rowCount) throw httpErr(400, 'una skill che ne incorpora altre non può essere incorporata');
    }
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query('delete from patologia_skill where patologia_id=$1', [req.params.id]);
      for (const x of l) await c.query('insert into patologia_skill (patologia_id, dopo_ordine, skill_id) values ($1,$2,$3)', [req.params.id, x.dopo_ordine, x.skill_id]);
      await c.query('commit');
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    return { ok: true };
  });
  // anteprima di una scheda della libreria con lo stesso template delle schede stampate (PDF)
  app.get('/api/libreria/patologie/:id/anteprima.pdf', { preHandler: soloOrg }, async (req, reply) => {
    await controllaScheda(pool, req.utente, req.params.id, { modifica: false });
    const { rows: [pt] } = await pool.query('select nome, sigla, is_master, gravita, tipologie, categoria, fasce, errori_gravi from patologia where id=$1', [req.params.id]);
    const { rows: voci } = await pool.query(
      `select pv.ordine as id, pv.sezione, v.testo, pv.is_sep, sp.mb, sp.be, sp.su, sp."in", sp.ne from patologia_voce pv
         join voce v on v.id=pv.voce_id join scala_punteggio sp on sp.id=pv.scala_id where pv.patologia_id=$1 order by pv.ordine`, [req.params.id]);
    const doc = creaDocumento(); const chunks = []; doc.on('data', (c) => chunks.push(c)); const fine = new Promise((r) => doc.on('end', r));
    if (èSkill(pt)) { disegnaSkill(doc, { titolo: pt.nome, modello: `SKILL ${pt.sigla}`, voci, fasce: pt.fasce, erroriGravi: pt.errori_gravi }); doc.end(); await fine;
      return reply.type('application/pdf').header('Content-Disposition', 'inline; filename="anteprima.pdf"').send(Buffer.concat(chunks)); }
    disegnaScheda(doc, { evento: { nome: 'Anteprima scheda', titolo_stampa: 'Anteprima scheda', luogo: '', data_txt: null }, squadra: { numero: 0, nome: 'Test' },
      scena: { codice: 'T', titolo: 'Nome Scena' }, scheda: { simulatore: 'M', titolo: pt.nome, is_master: pt.is_master, gravita: pt.gravita, parametri: { coscienza: 'Vigile', fr: 16, fc: 80, cute: 'Normale' } }, voci, compilazione: null, risposte: new Map(), vuota: true });
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
      `insert into patologia (codice, nome, sigla, is_bls, is_master, is_diu, categoria, categoria2, comitato, creata_da, macro, macro2, gravita, tipologie) values ($1,$2,$3,coalesce($4,false),coalesce($5,false),coalesce($6,false),$7,$8,$9,$10,$11,$12,$13,$14::text[]) returning *`,
      [codice, b.nome, b.sigla, b.is_bls, b.is_master, b.is_diu, (b.categoria || '').trim() || b.nome, (b.categoria2 || '').trim() || null, comitato, req.utente.id, b.macro || null, b.macro2 || null, b.gravita || null, tipologieValide(b.tipologie, ['gara'])]);
    if (Array.isArray(b.errori_gravi)) await db.query('update patologia set errori_gravi=$2::text[] where id=$1', [p.id, b.errori_gravi.map((x) => String(x).trim().slice(0, 200)).filter(Boolean).slice(0, 12)]);
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
  // avanzamento della gara: per ogni squadra e scena, grigio (non iniziata), giallo (in corso), verde (fatta); le soste non hanno schede
  app.get('/api/eventi/:id/avanzamento', { preHandler: soloOrg }, async (req) => calcolaAvanzamento(pool, req.params.id));
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
    if (b.evento_id) await verificaAccessoEvento(pool, req.utente, b.evento_id);
    else if (req.utente.per_evento && req.utente.ruolo !== 'admin') throw httpErr(403, 'non puoi creare eventi: chiedi a un admin');
    if (typeof b.dati !== 'string' || b.dati.length < 100) throw httpErr(400, 'file mancante');
    const buf = Buffer.from(b.dati, 'base64');
    if (buf.subarray(0, 2).toString() !== 'PK') throw httpErr(400, 'non è un file .xlsx');
    const tipoEvento = b.tipo === 'olimpiadi' ? 'olimpiadi' : 'gara';
    if (!b.evento_id && (!b.evento?.codice?.trim() || !b.evento?.nome?.trim())) throw httpErr(400, 'indica un evento esistente oppure codice e nome del nuovo evento');
    const e = b.evento || {};
    const opz = { eventoId: b.evento_id || undefined, eventoCodice: e.codice?.trim(), nomeEvento: e.nome?.trim(), titoloStampa: e.titolo_stampa?.trim() || e.nome?.trim(),
      luogo: e.luogo?.trim() || null, data: e.data || null, tipoEvento, attiva: false, sostituisci: b.sostituisci === true };
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    if (b.valutazioni === true) {
      if (!b.evento_id) throw httpErr(400, 'per importare le valutazioni scegli l\'evento che contiene già le scene');
      if (!èAllInOne(wb)) throw httpErr(400, 'le valutazioni si importano solo dai file «All in one» compilati');
      return inTransazione(pool, (db) => importaValutazioniAllInOne(db, wb, { eventoId: b.evento_id, sostituisci: b.sostituisci === true }));
    }
    return inTransazione(pool, async (db) => {
      const rep = èAllInOne(wb) ? await importaAllInOne(db, wb, opz) : await importaExcel(db, buf, opz);
      // squadre indicate a mano («1-Carpineti», una per riga) e archiviazione dell'evento come storico
      const sq = String(e.squadre || '').split(/\r?\n/).map((x) => x.trim().match(/^(\d{1,3})\s*[-–:.]\s*(.+)$/)).filter(Boolean);
      for (const [, n, nome] of sq) await db.query(`insert into squadra (evento_id, numero, nome, attiva) values ($1,$2,$3,true) on conflict (evento_id, numero) do nothing`, [rep.eventoId, Number(n), nome.trim()]);
      if (sq.length) rep.squadre = Math.max(rep.squadre || 0, sq.length);
      if (e.storico === true && !b.evento_id) await db.query('update evento set archiviato=true, attivo=false where id=$1', [rep.eventoId]);
      return rep;
    });
  });

  registraGestione(app, pool, { soloOrg, soloAdmin });
  registraTurni(app, pool, { soloOrg });
  registraAuth(app, pool, { fetchImpl, soloAdmin });
  registraRichieste(app, pool, { soloAdmin, fetchImpl });
  registraNotifiche(app, pool);
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
    reply.code(status).send({ errore: msg, ...(err.dettaglio && status < 500 ? { dettaglio: err.dettaglio } : {}) });
  });

  app.register(fastifyStatic, { root: fileURLToPath(new URL('../../web', import.meta.url)) });
  return app;
}
