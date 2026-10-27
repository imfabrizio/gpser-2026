import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { firmaToken, leggiToken, troppiTentativi, registraFallimento, azzeraFallimenti, hashPassword, verificaPassword } from './auth.js';
import { httpErr } from './services/compilazioni.js';
import { eStaff, ruoloEffettivo, AREE } from './permessi.js';
import { nuovoSegreto, verificaTotp, cifra, decifra, otpauth, nuoviCodiciRecupero, hashRecupero } from './mfa.js';

// aree = unione di quelle del ruolo principale e dei ruoli aggiuntivi; ruoli_extra = codici dei ruoli aggiuntivi
export const SQL_UTENTE = `select u.*,
  coalesce((select array_agg(distinct a) from ruolo r2, unnest(r2.aree) a where r2.codice = u.ruolo or r2.codice in (select x.ruolo from utente_ruolo_extra x where x.utente_id = u.id)), '{}') as aree,
  coalesce((select array_agg(x.ruolo) from utente_ruolo_extra x where x.utente_id = u.id), '{}') as ruoli_extra,
  -- accessi legati a un evento: chi è iscritto a una gara come giudice / giudice master ha quell'accesso solo per quella gara
  coalesce((select json_agg(json_build_object('evento_id', i.evento_id, 'ruolo', i.ruolo)) from iscrizione i join partecipante p on p.id = i.partecipante_id join evento e on e.id = i.evento_id
             where p.utente_id = u.id and not e.archiviato and i.ruolo in ('giudice','giudice_master')), '[]'::json) as ev_ruoli,
  coalesce((select array_agg(i.evento_id) from iscrizione i join partecipante p on p.id = i.partecipante_id join evento e on e.id = i.evento_id
             where p.utente_id = u.id and not e.archiviato and i.ruolo = 'organizzazione'), '{}') as ev_org from utente u`;
export const mfaObbligatoria = (u, via) => process.env.MFA_ORG !== '0' && eStaff(u) && !u.mfa_attiva && via === 'pwd';
export const profilo = (u, via) => ({ id: u.id, nome: u.nome, email: u.email, ruolo: ruoloEffettivo(u), ruolo_codice: u.ruolo, ruoli_extra: u.ruoli_extra || [], per_evento: !!u.per_evento, admin: !!u.admin, aree: u.admin ? Object.keys(AREE) : (u.aree || []), evento_id: u.evento_id, tema: u.tema ?? null, mfa_attiva: !!u.mfa_attiva, mfa_da_configurare: mfaObbligatoria(u, via) });
export const creaSessione = (u, via) => ({ token: firmaToken({ id: u.id, via }), utente: profilo(u, via) });

// ── provider esterni (OpenID Connect, flusso "authorization code" + PKCE) ──
const PROVIDER = {
  google: () => ({ id: process.env.GOOGLE_CLIENT_ID, segreto: process.env.GOOGLE_CLIENT_SECRET,
    auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', iss: (i) => ['https://accounts.google.com', 'accounts.google.com'].includes(i) }),
  microsoft: () => { const t = process.env.MS_TENANT || ''; return { id: process.env.MS_CLIENT_ID, segreto: process.env.MS_CLIENT_SECRET, tenant: t,
    auth: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`, token: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, iss: (i) => i === `https://login.microsoftonline.com/${t}/v2.0` }; },
};
const configurato = (p) => { const c = PROVIDER[p]?.(); return c && c.id && c.segreto && (p !== 'microsoft' || /^[0-9a-f-]{36}$/i.test(c.tenant)) ? c : null; };   // Microsoft: solo con l'ID del tenant (niente "common": email non verificabili)
const b64u = (b) => Buffer.from(b).toString('base64url');
const ticket = new Map();   // ticket monouso -> { id, exp } (in memoria: un solo processo)
setInterval(() => { const n = Date.now(); for (const [k, v] of ticket) if (v.exp < n) ticket.delete(k); }, 60e3).unref();
const leggiCookie = (req, nome) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === nome)?.[1];

export function registraAuth(app, pool, { fetchImpl = fetch, soloAdmin } = {}) {
  const baseUrl = (req) => (process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, '');

  app.get('/api/auth/config', async () => ({ google: !!configurato('google'), microsoft: !!configurato('microsoft') }));

  app.get('/api/auth/:prov/inizio', async (req, reply) => {
    const c = configurato(req.params.prov); if (!c) throw httpErr(404, 'accesso non configurato');
    // il cookie di sessione SSO deve nascere sullo stesso indirizzo a cui il provider ritorna (PUBLIC_URL): se si parte da un altro (es. *.onrender.com), si riparte da quello giusto
    const pub = process.env.PUBLIC_URL && process.env.PUBLIC_URL.replace(/\/$/, '');
    const qui = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
    if (pub && /^https?:\/\//.test(pub) && qui !== pub) return reply.redirect(`${pub}/api/auth/${req.params.prov}/inizio`);
    const state = b64u(crypto.randomBytes(16)), nonce = b64u(crypto.randomBytes(16)), verifier = b64u(crypto.randomBytes(32));
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({ client_id: c.id, redirect_uri: `${baseUrl(req)}/api/auth/${req.params.prov}/callback`, response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', ...(req.params.prov === 'google' ? { prompt: 'select_account' } : {}) });
    const sicuro = baseUrl(req).startsWith('https') ? '; Secure' : '';
    reply.header('Set-Cookie', `sso=${firmaToken({ p: req.params.prov, state, nonce, verifier }, 0.17)}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600${sicuro}`);
    return reply.redirect(`${c.auth}?${q}`);
  });

  app.get('/api/auth/:prov/callback', async (req, reply) => {
    const errore = (m) => reply.header('Set-Cookie', 'sso=; Path=/api/auth; Max-Age=0').redirect(`/#sso-errore=${m}`);
    const prov = req.params.prov, c = configurato(prov); if (!c) return errore('non_configurato');
    const ck = leggiToken(leggiCookie(req, 'sso'));
    const { code, state } = req.query;
    if (!ck || ck.p !== prov || !code || state !== ck.state) return errore('sessione');
    let idt;
    try {
      const r = await fetchImpl(c.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: c.id, client_secret: c.segreto, redirect_uri: `${baseUrl(req)}/api/auth/${prov}/callback`, code_verifier: ck.verifier }) });
      const j = await r.json(); if (!r.ok || !j.id_token) return errore('provider');
      // l'id_token arriva direttamente dal provider su TLS (non dal browser): se ne controllano emittente, destinatario, scadenza e nonce
      idt = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url').toString());
    } catch { return errore('provider'); }
    if (!c.iss(idt.iss) || idt.aud !== c.id || !(idt.exp * 1000 > Date.now()) || idt.nonce !== ck.nonce) return errore('token');
    if (prov === 'microsoft' && idt.tid !== c.tenant) return errore('tenant');
    const email = String(idt.email || (prov === 'microsoft' ? idt.preferred_username : '') || '').toLowerCase();
    if (!idt.sub) return errore('token');
    if (prov === 'google' && !(idt.email_verified === true || idt.email_verified === 'true')) return errore('email_non_verificata');
    // 1) identità già collegata; 2) altrimenti l'utente registrato con quella email (l'admin deve averlo creato prima)
    let { rows: [u] } = await pool.query(SQL_UTENTE + ' where u.attivo and u.id = (select utente_id from utente_identita where provider=$1 and sub=$2)', [prov, idt.sub]);
    if (!u && email && prov === 'google') {
      ({ rows: [u] } = await pool.query(SQL_UTENTE + ' where lower(u.email)=$1 and u.attivo', [email]));
      if (u) await pool.query('insert into utente_identita (provider, sub, utente_id, email) values ($1,$2,$3,$4) on conflict do nothing', [prov, idt.sub, u.id, email]);
    }
    if (!u) {            // sconosciuto: non entra, ma può presentare una richiesta (valida 48 ore) che l'amministratore approva o rifiuta
      if (!email) return errore('non_autorizzato');
      await pool.query('delete from richiesta_accesso where scade_il < now()');
      const { rows: [r] } = await pool.query(
        `insert into richiesta_accesso (provider, sub, email, nome, cognome) values ($1,$2,$3,$4,$5)
         on conflict (provider, sub) do update set email=excluded.email returning id`,
        [prov, idt.sub, email, String(idt.given_name || '').slice(0, 80) || null, String(idt.family_name || '').slice(0, 80) || null]);
      if (prov === 'microsoft') await pool.query('update richiesta_accesso set compilata=true where id=$1 and exists (select 1 from utente where lower(email)=$2)', [r.id, email]);
      const tr = b64u(crypto.randomBytes(24)); ticket.set(tr, { rid: r.id, exp: Date.now() + 60e3 });
      return reply.header('Set-Cookie', 'sso=; Path=/api/auth; Max-Age=0').redirect(`/#sso=${tr}`);
    }
    const t = b64u(crypto.randomBytes(24)); ticket.set(t, { id: u.id, exp: Date.now() + 60e3 });
    return reply.header('Set-Cookie', 'sso=; Path=/api/auth; Max-Age=0').redirect(`/#sso=${t}`);
  });

  app.post('/api/auth/ticket', async (req) => {          // il ticket monouso diventa la sessione: il token non passa mai dall'indirizzo
    const t = ticket.get(req.body?.ticket); ticket.delete(req.body?.ticket);
    if (!t || t.exp < Date.now()) throw httpErr(401, 'accesso scaduto: riprova');
    if (t.rid) return { token: firmaToken({ rid: t.rid, via: 'sso' }, 48), utente: { in_attesa: true } };
    const { rows: [u] } = await pool.query(SQL_UTENTE + ' where u.id=$1 and u.attivo', [t.id]);
    if (!u) throw httpErr(401, 'utente non valido');
    if (process.env.SSO_RICHIEDE_MFA === '1') {
      if (u.mfa_attiva) return { mfa: true, ticket: firmaToken({ id: u.id, t: 'mfa' }, 0.1) };
      return creaSessione(u, 'pwd');
    }
    return creaSessione(u, 'sso');
  });

  // ── secondo fattore dopo la password ──
  app.post('/api/login/mfa', async (req) => {
    const t = leggiToken(req.body?.ticket); if (!t || t.t !== 'mfa') throw httpErr(401, 'accesso scaduto: ricomincia');
    const chiave = `mfa|${req.ip}|${t.id}`; if (troppiTentativi(chiave)) throw httpErr(429, 'troppi tentativi: riprova tra qualche minuto');
    const { rows: [u] } = await pool.query(SQL_UTENTE + ' where u.id=$1 and u.attivo and u.mfa_attiva', [t.id]);
    if (!u) throw httpErr(401, 'accesso non valido');
    const cod = String(req.body?.codice || '').trim();
    let ok = verificaTotp(decifra(u.mfa_secret), cod);
    if (!ok) {                                           // codice di recupero: si può usare una sola volta
      const h = hashRecupero(cod);
      // Il consumo è atomico: due richieste concorrenti non riutilizzano il codice.
      const { rowCount } = await pool.query('update utente set mfa_recupero = array_remove(mfa_recupero, $2) where id=$1 and $2 = any(mfa_recupero)', [u.id, h]);
      ok = rowCount === 1;
    }
    if (!ok) { registraFallimento(chiave); throw httpErr(401, 'codice non valido'); }
    azzeraFallimenti(chiave);
    return creaSessione(u, 'pwd');
  });

  // ── gestione del proprio MFA ──
  const utenteDb = async (id) => (await pool.query(SQL_UTENTE + ' where u.id=$1', [id])).rows[0];
  // cambio della propria password (serve la password attuale; chi accede solo con Google/Microsoft non ne ha una propria)
  app.post('/api/me/password', async (req) => {
    const { attuale, nuova } = req.body || {};
    if (typeof nuova !== 'string' || nuova.length < 8) throw httpErr(400, 'la nuova password deve avere almeno 8 caratteri');
    const chiave = `pw|${req.ip}|${req.utente.id}`; if (troppiTentativi(chiave)) throw httpErr(429, 'troppi tentativi: riprova tra qualche minuto');
    const u = await utenteDb(req.utente.id);
    if (typeof attuale !== 'string' || !verificaPassword(attuale, u.password_hash)) { registraFallimento(chiave); throw httpErr(400, 'la password attuale non è corretta'); }
    azzeraFallimenti(chiave);
    await pool.query('update utente set password_hash=$2 where id=$1', [u.id, hashPassword(nuova)]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'password_cambiata','utente',$2::text)`, [u.id, u.id]);
    return { ok: true };
  });
  app.get('/api/mfa', async (req) => {
    const u = await utenteDb(req.utente.id);
    const { rows } = await pool.query('select provider from utente_identita where utente_id=$1', [u.id]);
    return { attiva: u.mfa_attiva, recupero_rimasti: u.mfa_recupero.length, obbligatoria: mfaObbligatoria({ ...u, mfa_attiva: false }, 'pwd'), identita: rows.map((r) => r.provider) };
  });
  app.post('/api/mfa/inizia', async (req) => {
    const u = await utenteDb(req.utente.id); if (u.mfa_attiva) throw httpErr(409, 'MFA già attiva');
    const segreto = nuovoSegreto();
    await pool.query('update utente set mfa_secret=$2 where id=$1', [u.id, cifra(segreto)]);
    const uri = otpauth(segreto, u.email);
    return { segreto, otpauth: uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  });
  app.post('/api/mfa/conferma', async (req) => {
    const u = await utenteDb(req.utente.id); if (u.mfa_attiva) throw httpErr(409, 'MFA già attiva');
    if (!u.mfa_secret) throw httpErr(400, 'avvia prima la configurazione');
    if (!verificaTotp(decifra(u.mfa_secret), req.body?.codice)) throw httpErr(400, 'codice non valido: controlla l\'ora del telefono e riprova');
    const { chiari, hash } = nuoviCodiciRecupero();
    await pool.query('update utente set mfa_attiva=true, mfa_recupero=$2 where id=$1', [u.id, hash]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'mfa_attivata','utente',$2::text)`, [u.id, u.id]);
    return { codici_recupero: chiari };                 // mostrati una sola volta
  });
  app.post('/api/mfa/disattiva', async (req) => {
    const u = await utenteDb(req.utente.id); if (!u.mfa_attiva) throw httpErr(409, 'MFA non attiva');
    if (mfaObbligatoria({ ...u, mfa_attiva: false }, req.utente.via)) throw httpErr(400, 'la MFA è obbligatoria per il tuo ruolo');
    if (!verificaTotp(decifra(u.mfa_secret), req.body?.codice)) throw httpErr(400, 'codice non valido');
    await pool.query(`update utente set mfa_attiva=false, mfa_secret=null, mfa_recupero='{}' where id=$1`, [u.id]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'mfa_disattivata','utente',$2::text)`, [u.id, u.id]);
    return { ok: true };
  });
  app.post('/api/utenti/:id/mfa-reset', { preHandler: soloAdmin }, async (req) => {   // chi perde il telefono e i codici di recupero
    await pool.query(`update utente set mfa_attiva=false, mfa_secret=null, mfa_recupero='{}' where id=$1`, [req.params.id]);
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1,'mfa_reset','utente',$2)`, [req.utente.id, req.params.id]);
    return { ok: true };
  });
}
