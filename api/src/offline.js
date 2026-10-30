// Gara offline: scene senza copertura, codici temporanei dei giudici, pacchetto cifrato per i tablet, elenco dei dispositivi e sincronizzazione al rientro.
import crypto from 'node:crypto';
import { httpErr, inDirezione } from './services/compilazioni.js';
import { verificaAccessoEvento } from './enti.js';
import { cifra, decifra } from './mfa.js';
import { firmaToken } from './auth.js';
import { inTransazione } from './db.js';

// segnale interno: solo le richieste fatte dal server stesso per la sincronizzazione offline lo conoscono
export const INTERNO = crypto.randomBytes(16).toString('hex');
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // senza 0/O, 1/I: si legge da un foglietto
export const nuovoCodice = () => { const b = crypto.randomBytes(8); return Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join(''); };
export const formatoCodice = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const ITER = 100000;
// cifratura del pacchetto: PBKDF2-SHA256 + AES-256-GCM (la stessa che usa il browser con WebCrypto); ciphertext = dati + tag
export function cifraBlob(codice, chiaro) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const chiave = crypto.pbkdf2Sync(codice, salt, ITER, 32, 'sha256');
  const c = crypto.createCipheriv('aes-256-gcm', chiave, iv);
  const ct = Buffer.concat([c.update(chiaro, 'utf8'), c.final(), c.getAuthTag()]);
  return { salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), iter: ITER };
}
export function aprBlob(codice, b) {
  const chiave = crypto.pbkdf2Sync(codice, Buffer.from(b.salt, 'base64'), b.iter || ITER, 32, 'sha256');
  const ct = Buffer.from(b.ct, 'base64'); const d = crypto.createDecipheriv('aes-256-gcm', chiave, Buffer.from(b.iv, 'base64'));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8');
}
const tipoDa = (ua = '', larg = 0) => (/iPad|Tablet|Android(?!.*Mobile)/i.test(ua) || (/Macintosh/.test(ua) && larg && larg < 1100 && larg >= 600 && false) ? 'tablet' : /Mobile|iPhone|Android/i.test(ua) ? 'telefono' : 'computer');
const sistemaDa = (ua = '') => (/iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'altro') + (/Edg\//.test(ua) ? ' · Edge' : /Chrome\//.test(ua) ? ' · Chrome' : /Safari\//.test(ua) ? ' · Safari' : /Firefox\//.test(ua) ? ' · Firefox' : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registraOffline(app, pool, { soloOrg }) {
  const RUOLI_ORG = ['admin', 'organizzazione'];
  // chi gestisce l'offline di una gara: organizzazione/admin (con accesso alla gara) oppure la direzione gara di quella gara
  const gestore = async (utente, eventoId) => {
    if (RUOLI_ORG.includes(utente.ruolo)) { await verificaAccessoEvento(pool, utente, eventoId); return true; }
    if (await inDirezione(pool, utente, eventoId)) return true;
    throw httpErr(403, 'solo direzione gara o organizzazione');
  };
  const chiama = (utenteId, method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + firmaToken({ id: utenteId, via: 'pw' }, 1), 'x-offline-interno': INTERNO } });
  const jsonOk = (r) => { if (r.statusCode >= 400) throw httpErr(r.statusCode, JSON.parse(r.body || '{}').errore || 'errore'); return JSON.parse(r.body); };

  // ── dispositivi ──
  app.post('/api/dispositivi/registra', async (req) => {
    const b = req.body || {}; if (!UUID.test(b.id || '')) throw httpErr(400, 'identificativo non valido');
    const ua = String(req.headers['user-agent'] || ''), larg = Number(b.larghezza) || 0;
    const tipo = ['telefono', 'tablet', 'computer'].includes(b.tipo) ? b.tipo : tipoDa(ua, larg);
    await pool.query(`insert into dispositivo (id, tipo, sistema, ultimo_utente) values ($1,$2,$3,$4)
      on conflict (id) do update set visto_il = now(), ultimo_utente = $4, sistema = $3, tipo = $2`, [b.id, tipo, sistemaDa(ua), req.utente.id]);
    const { rows: [d] } = await pool.query('select id, nome, modalita, evento_id from dispositivo where id=$1', [b.id]);
    return d;
  });
  app.get('/api/dispositivi', { preHandler: soloOrg }, async () => (await pool.query(
    `select d.id, d.nome, d.tipo, d.sistema, d.modalita, d.evento_id, e.nome as evento, d.visto_il, d.preparato_il, d.ultima_sync, u.nome as ultimo_utente
       from dispositivo d left join utente u on u.id = d.ultimo_utente left join evento e on e.id = d.evento_id order by d.visto_il desc limit 200`)).rows);
  app.patch('/api/dispositivi/:id', { preHandler: soloOrg }, async (req) => {
    const nome = String(req.body?.nome ?? '').trim().slice(0, 80) || null;
    const r = await pool.query('update dispositivo set nome=$2 where id=$1', [req.params.id, nome]); if (!r.rowCount) throw httpErr(404, 'dispositivo inesistente');
    return { ok: true };
  });
  app.post('/api/dispositivi/:id/online', { preHandler: soloOrg }, async (req) => {
    await pool.query(`update dispositivo set modalita='online', evento_id=null where id=$1`, [req.params.id]); return { ok: true };
  });

  // ── scene offline e codici ──
  app.put('/api/scene/:id/offline', { preHandler: soloOrg }, async (req) => {
    const { rows: [s] } = await pool.query('select evento_id from scena where id=$1', [req.params.id]); if (!s) throw httpErr(404, 'scena inesistente');
    await verificaAccessoEvento(pool, req.utente, s.evento_id);
    await pool.query('update scena set offline=$2 where id=$1', [req.params.id, !!req.body?.offline]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'scena_offline','scena',$2,$3)`, [req.utente.id, req.params.id, JSON.stringify({ offline: !!req.body?.offline })]);
    return { ok: true };
  });
  // chi lavora nelle scene offline: giudici assegnati alle schede e giudici master della scena
  const personeOffline = async (db, eventoId) => (await db.query(
    `select u.id as utente_id, u.nome, u.email, bool_or(x.master) as master, array_agg(distinct x.scena) as scene from (
       select a.utente_id, false as master, sc.codice as scena from assegnazione a join scena_scheda s on s.id=a.scheda_id join scena sc on sc.id=s.scena_id where sc.evento_id=$1 and sc.offline
       union all select m.utente_id, true, sc.codice from scena_master m join scena sc on sc.id=m.scena_id where sc.evento_id=$1 and sc.offline) x
     join utente u on u.id = x.utente_id where u.attivo group by u.id, u.nome, u.email order by u.nome`, [eventoId])).rows;
  const assicuraCodici = async (db, eventoId, rigenera = false) => {
    const persone = await personeOffline(db, eventoId);
    if (rigenera) await db.query('delete from offline_codice where evento_id=$1 and utente_id = any($2::uuid[])', [eventoId, persone.map((p) => p.utente_id)]);
    for (const p of persone) await db.query('insert into offline_codice (evento_id, utente_id, codice_cifrato) values ($1,$2,$3) on conflict do nothing', [eventoId, p.utente_id, cifra(nuovoCodice())]);
    const { rows } = await db.query('select utente_id, codice_cifrato from offline_codice where evento_id=$1', [eventoId]);
    const m = new Map(rows.map((r) => [r.utente_id, decifra(r.codice_cifrato)]));
    return persone.map((p) => ({ ...p, codice: m.get(p.utente_id) }));
  };
  app.get('/api/eventi/:id/offline', { preHandler: soloOrg }, async (req) => {
    const id = req.params.id; await verificaAccessoEvento(pool, req.utente, id, false);
    const scene = (await pool.query('select id, codice, titolo, offline, sosta from scena where evento_id=$1 order by ordine, codice', [id])).rows;
    const persone = await personeOffline(pool, id);
    const { rows: gen } = await pool.query('select utente_id from offline_codice where evento_id=$1', [id]);
    const dispositivi = (await pool.query(`select d.id, d.nome, d.tipo, d.sistema, d.modalita, d.visto_il, d.preparato_il, d.ultima_sync, u.nome as ultimo_utente
      from dispositivo d left join utente u on u.id=d.ultimo_utente where d.evento_id=$1 or d.visto_il > now() - interval '60 days' order by d.visto_il desc limit 100`, [id])).rows;
    return { scene, persone: persone.map((p) => ({ ...p, codice_pronto: gen.some((g) => g.utente_id === p.utente_id) })), dispositivi };
  });
  // genera i codici mancanti (o li rigenera tutti) e li mostra: servono per stampare i foglietti
  app.post('/api/eventi/:id/offline/codici', { preHandler: soloOrg }, async (req) => inTransazione(pool, async (db) => {
    await verificaAccessoEvento(db, req.utente, req.params.id);
    const l = await assicuraCodici(db, req.params.id, !!req.body?.rigenera);
    await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'codici_offline','evento',$2,$3)`, [req.utente.id, req.params.id, JSON.stringify({ rigenera: !!req.body?.rigenera, persone: l.length })]);
    return l.map((p) => ({ utente_id: p.utente_id, nome: p.nome, master: p.master, scene: p.scene, codice: formatoCodice(p.codice) }));
  }));

  // ── pacchetto per il tablet: tutto cifrato, ogni giudice apre solo il suo con il suo codice ──
  app.post('/api/eventi/:id/offline/pacchetto', async (req) => {
    const id = req.params.id; await gestore(req.utente, id);
    const dev = req.body?.dispositivo_id; if (!UUID.test(dev || '')) throw httpErr(400, 'dispositivo non registrato');
    const { rows: [ev] } = await pool.query('select id, nome from evento where id=$1', [id]); if (!ev) throw httpErr(404, 'gara inesistente');
    const scene = (await pool.query('select id, codice, titolo from scena where evento_id=$1 and offline order by ordine, codice', [id])).rows;
    if (!scene.length) throw httpErr(400, 'nessuna scena segnata come offline');
    const persone = await inTransazione(pool, (db) => assicuraCodici(db, id));
    const ids = scene.map((s) => s.id);
    const giudici = [], riaperture = [];
    for (const p of persone) {
      // schede di questa persona nelle scene offline: assegnate a lei (e la scheda Master per il master di scena)
      const { rows: sk } = await pool.query(
        `select distinct s.id, s.scena_id, s.titolo, s.slot from scena_scheda s where s.scena_id = any($1::uuid[]) and (
           exists (select 1 from assegnazione a where a.scheda_id=s.id and a.utente_id=$2)
           or (s.is_master and exists (select 1 from scena_master m where m.scena_id=s.scena_id and m.utente_id=$2))) order by s.slot`, [ids, p.utente_id]);
      const squadre = jsonOk(await chiama(p.utente_id, 'GET', `/api/eventi/${id}/squadre`));
      const schede = {}, compilazioni = {};
      for (const k of sk) {
        schede[k.id] = jsonOk(await chiama(p.utente_id, 'GET', `/api/schede/${k.id}`));
        for (const q of squadre) { const c = jsonOk(await chiama(p.utente_id, 'GET', `/api/compilazioni?scheda=${k.id}&squadra=${q.id}`)); if (c.compilazione) compilazioni[`${k.id}|${q.id}`] = c; }
      }
      const chiaro = JSON.stringify({ utente: { id: p.utente_id, nome: p.nome, master: !!p.master }, evento: ev, scene: scene.map((s) => ({ ...s, schede: sk.filter((k) => k.scena_id === s.id).map((k) => ({ id: k.id, titolo: k.titolo, slot: k.slot })) })), schede, squadre, compilazioni });
      giudici.push({ utente_id: p.utente_id, nome: p.nome, ...cifraBlob(p.codice, chiaro) });
      if (p.master) riaperture.push({ utente_id: p.utente_id, nome: p.nome, ...cifraBlob(p.codice, 'ok') });   // il codice del master serve a riaprire una scheda chiusa sul tablet del giudice
    }
    await pool.query(`insert into dispositivo (id, ultimo_utente, modalita, evento_id, preparato_il) values ($1,$2,'offline',$3,now())
      on conflict (id) do update set modalita='offline', evento_id=$3, preparato_il=now(), ultimo_utente=$2`, [dev, req.utente.id, id]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'tablet_offline','evento',$2,$3)`, [req.utente.id, id, JSON.stringify({ dispositivo: dev, giudici: giudici.length })]);
    return { versione: 1, creato_il: new Date().toISOString(), evento: ev, dispositivo_id: dev, scene, giudici, riaperture };
  });

  // ── rientro online: i risultati salvati sul tablet entrano come se li avesse inviati il giudice ──
  app.post('/api/offline/sync', async (req) => {
    const b = req.body || {}; if (!UUID.test(b.evento_id || '') || !Array.isArray(b.invii)) throw httpErr(400, 'dati non validi');
    if (b.invii.length > 500) throw httpErr(400, 'troppi invii (max 500)');
    await gestore(req.utente, b.evento_id);
    const risultati = [];
    for (const i of b.invii) {
      const r = { scheda_id: i?.payload?.scheda_id, squadra_id: i?.payload?.squadra_id, ok: false };
      try {
        if (!UUID.test(i.utente_id || '') || !i.payload) throw httpErr(400, 'invio non valido');
        const { rows: [chk] } = await pool.query('select 1 from scena_scheda s join scena sc on sc.id=s.scena_id where s.id=$1 and sc.evento_id=$2 and sc.offline', [i.payload.scheda_id, b.evento_id]);
        if (!chk) throw httpErr(400, 'scheda non appartenente a una scena offline di questa gara');
        for (const rip of (i.riaperture || []).slice(0, 20)) {
          if (!UUID.test(rip.master_id || '')) continue;
          const { rows: [c] } = await pool.query('select id, stato from compilazione where scheda_id=$1 and squadra_id=$2', [i.payload.scheda_id, i.payload.squadra_id]);
          if (c && c.stato !== 'bozza') jsonOk(await chiama(rip.master_id, 'POST', `/api/compilazioni/${c.id}/riapri`, {}));
        }
        const out = jsonOk(await chiama(i.utente_id, 'POST', '/api/sync', { ...i.payload, origine: 'tablet_offline' }));
        r.ok = true; r.esito = out;
      } catch (e) { r.errore = e.message; }
      risultati.push(r);
    }
    const errori = risultati.filter((x) => !x.ok).length;
    if (UUID.test(b.dispositivo_id || '')) await pool.query(`update dispositivo set ultima_sync=now(), ultimo_utente=$2, modalita = case when $3 = 0 then 'online' else modalita end where id=$1`, [b.dispositivo_id, req.utente.id, errori]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'sync_offline','evento',$2,$3)`, [req.utente.id, b.evento_id, JSON.stringify({ invii: b.invii.length, errori, dispositivo: b.dispositivo_id || null })]);
    return { risultati, ok: risultati.length - errori, errori };
  });
}
