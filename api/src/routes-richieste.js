import crypto from 'node:crypto';
// Registrazione con approvazione: chi entra con Google/Microsoft senza essere registrato compila un modulo;
// l'amministratore lo approva (scegliendo il ruolo) o lo rifiuta. Senza risposta entro 48 ore la richiesta sparisce.
import { hashPassword } from './auth.js';
import { cifra, decifra } from './mfa.js';
import { verificaCodiceFiscale } from './codice-fiscale.js';
import { hashCf } from './anagrafica.js';
import { inTransazione } from './db.js';
import { httpErr } from './services/compilazioni.js';

export const RUOLI_GARA = {
  partecipante_leader: 'Partecipante – capo squadra', partecipante_membro: 'Partecipante – componente', giudice: 'Giudice', giudice_master: 'Giudice master',
  allenatore: 'Allenatore', accompagnatore: 'Accompagnatore', simulatore: 'Simulatore', truccatore: 'Truccatore', fotografo: 'Fotografo', supporter: 'Supporter', altro: 'Altro ruolo (lo assegna l\'organizzazione)',
};
const CON_SQUADRA = ['partecipante_leader', 'partecipante_membro', 'allenatore', 'accompagnatore', 'fotografo', 'supporter'];
const RUOLO_APP = { giudice: 'giudice', giudice_master: 'giudice_master' };       // gli altri partono come "partecipante" (nessun potere)
const pulisci = (v, max = 80) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export const eliminaRichiesteScadute = (pool) => pool.query('delete from richiesta_accesso where scade_il < now()');

export function registraRichieste(app, pool, { soloAdmin, fetchImpl = fetch }) {
  const pulizia = setInterval(() => eliminaRichiesteScadute(pool).catch(() => {}), 30 * 60e3); pulizia.unref();
  app.addHook('onClose', async () => clearInterval(pulizia));

  async function notifica(r) {                    // email facoltativa (Resend): senza chiave resta solo l'elenco nell'app
    const chiave = process.env.RESEND_API_KEY, a = process.env.NOTIFICA_EMAIL;
    if (!chiave || !a) return;
    const base = process.env.PUBLIC_URL || '';
    try {
      await fetchImpl('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${chiave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.NOTIFICA_DA || 'GareCRI <onboarding@resend.dev>', to: [a], subject: `Nuova richiesta di accesso: ${r.nome} ${r.cognome}`,
          text: `${r.nome} ${r.cognome} (${r.email}) chiede l'accesso come "${RUOLI_GARA[r.ruolo_gara] || r.ruolo_gara}".\nComitato: ${r.comitato} (${r.provincia}).\n\nApri la richiesta: ${base}/admin.html#richieste\nSe non rispondi entro 48 ore la richiesta viene cancellata.` }) });
    } catch { /* la notifica è un di più: la richiesta resta comunque in elenco */ }
  }

  const rich = async (req) => {
    if (!req.richiesta) throw httpErr(403, 'non è una richiesta di accesso');
    return req.richiesta;
  };

  app.get('/api/registrazione', { preHandler: rich }, async (req) => {
    const r = req.richiesta;
    const { rows: squadre } = await pool.query(
      `select s.id, s.nome, s.comitato, e.nome as evento from squadra s join evento e on e.id=s.evento_id
        where s.attiva and (e.attivo or e.data >= current_date) order by e.data, s.numero`);
    return { email: r.email, nome: r.nome, cognome: r.cognome, compilata: r.compilata, scade_il: r.scade_il, squadre, ruoli: RUOLI_GARA, con_squadra: CON_SQUADRA };
  });

  app.post('/api/registrazione', { preHandler: rich }, async (req) => {
    const b = req.body || {}, r = req.richiesta;
    const nome = pulisci(b.nome), cognome = pulisci(b.cognome), comitato = pulisci(b.comitato, 120), provincia = pulisci(b.provincia, 40).toUpperCase();
    const ruolo = String(b.ruolo_gara || '');
    if (!nome || !cognome || !comitato || !provincia) throw httpErr(400, 'nome, cognome, comitato e provincia sono obbligatori');
    if (!RUOLI_GARA[ruolo]) throw httpErr(400, 'scegli un ruolo');
    let squadraId = null;
    if (CON_SQUADRA.includes(ruolo)) {
      if (!b.squadra_id) throw httpErr(400, 'per questo ruolo la squadra è obbligatoria');
      const { rowCount } = await pool.query('select 1 from squadra where id=$1', [b.squadra_id]);
      if (!rowCount) throw httpErr(400, 'squadra non valida');
      squadraId = b.squadra_id;
    }
    const cf = verificaCodiceFiscale(b.codice_fiscale, cognome, nome);
    if (!cf.ok) throw httpErr(400, cf.errore);
    await pool.query(
      `update richiesta_accesso set nome=$2, cognome=$3, cf_cifrato=$4, cf_coerente=$5, comitato=$6, provincia=$7, ruolo_gara=$8, squadra_id=$9,
         codice_ruolo=$10, compilata=true, scade_il = now() + interval '48 hours' where id=$1`,
      [r.id, nome, cognome, cifra(cf.normalizzato), cf.coerente, comitato, provincia, ruolo, squadraId, pulisci(b.codice_ruolo, 40) || null]);
    notifica({ ...r, nome, cognome, comitato, provincia, ruolo_gara: ruolo });
    return { ok: true, scade_il: new Date(Date.now() + 48 * 3600e3).toISOString() };
  });

  // ── lato amministratore ──
  const elenco = async () => {
    await eliminaRichiesteScadute(pool);
    return (await pool.query(
      `select r.id, r.email, r.nome, r.cognome, r.cf_cifrato, r.cf_coerente, r.comitato, r.provincia, r.ruolo_gara, r.codice_ruolo, r.created_at, r.scade_il, r.provider,
              s.nome as squadra, e.nome as evento, r.squadra_id
         from richiesta_accesso r left join squadra s on s.id=r.squadra_id left join evento e on e.id=s.evento_id where r.compilata order by r.scade_il`)).rows;
  };
  app.get('/api/richieste', { preHandler: soloAdmin }, async () =>
    (await elenco()).map(({ cf_cifrato, ...r }) => ({ ...r, codice_fiscale: cf_cifrato ? decifra(cf_cifrato) : null,
      ruolo_proposto: RUOLO_APP[r.ruolo_gara] || 'partecipante', ruolo_gara_nome: RUOLI_GARA[r.ruolo_gara] || r.ruolo_gara })));
  app.get('/api/richieste/conteggio', { preHandler: soloAdmin }, async () => ({ n: (await elenco()).length }));

  app.post('/api/richieste/:id/approva', { preHandler: soloAdmin }, async (req) => {
    const ruolo = req.body?.ruolo;
    if (!ruolo || !(await pool.query('select 1 from ruolo where codice=$1', [ruolo])).rowCount) throw httpErr(400, 'scegli il ruolo da assegnare');
    return inTransazione(pool, async (db) => {
      const { rows: [r] } = await db.query('select * from richiesta_accesso where id=$1 and compilata and scade_il > now() for update', [req.params.id]);
      if (!r) throw httpErr(404, 'richiesta inesistente o scaduta');
      const { rows: [dup] } = await db.query('select 1 from utente where lower(email)=lower($1)', [r.email]);
      if (dup) throw httpErr(409, 'esiste già un utente con questa email');
      const { rows: [u] } = await db.query(
        `insert into utente (email, nome, ruolo, admin, password_hash, ruolo_gara, squadra_id, comitato, provincia, evento_id)
         values (lower($1),$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, email, nome, ruolo, admin`,
        [r.email, `${r.nome} ${r.cognome}`, ruolo, req.body?.admin === true, hashPassword(crypto.randomBytes(24).toString('base64url')), r.ruolo_gara, r.squadra_id, r.comitato, r.provincia, req.body?.evento_id || null]);
      // anagrafica: la persona c'è già (stesso codice fiscale o stessa email) → si collega e si aggiorna, altrimenti si crea
      const cf = decifra(r.cf_cifrato), h = hashCf(cf);
      let { rows: [p] } = await db.query('select id, utente_id from partecipante where cf_hash=$1', [h]);
      if (!p) ({ rows: [p] } = await db.query('select id, utente_id from partecipante where lower(email)=lower($1) and utente_id is null order by created_at limit 1', [r.email]));
      if (p?.utente_id) throw httpErr(409, 'la persona in anagrafica ha già un altro accesso');
      if (p) await db.query(`update partecipante set cognome=$2, nome=$3, email=$4, comitato=$5, provincia=$6, cf_cifrato=$7, cf_hash=$8, ruolo_gara=$9, utente_id=$10 where id=$1`,
        [p.id, r.cognome, r.nome, r.email, r.comitato, r.provincia, r.cf_cifrato, h, r.ruolo_gara, u.id]);
      else ({ rows: [p] } = await db.query(`insert into partecipante (cognome, nome, email, comitato, provincia, cf_cifrato, cf_hash, ruolo_gara, utente_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [r.cognome, r.nome, r.email, r.comitato, r.provincia, r.cf_cifrato, h, r.ruolo_gara, u.id]));
      if (r.squadra_id && ['partecipante_leader', 'partecipante_membro'].includes(r.ruolo_gara))     // chi gareggia entra nella squadra scelta
        await db.query('insert into squadra_membro (squadra_id, partecipante_id, ruolo) values ($1,$2,$3) on conflict do nothing', [r.squadra_id, p.id, r.ruolo_gara === 'partecipante_leader' ? 'capo squadra' : 'componente']);
      await db.query('insert into utente_identita (provider, sub, utente_id, email) values ($1,$2,$3,$4) on conflict do nothing', [r.provider, r.sub, u.id, r.email]);
      await db.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'richiesta_approvata','utente',$2::text)`, [req.utente.id, u.id]);
      await db.query('delete from richiesta_accesso where id=$1', [r.id]);
      return u;
    });
  });
  app.delete('/api/richieste/:id', { preHandler: soloAdmin }, async (req) => {
    const { rowCount } = await pool.query('delete from richiesta_accesso where id=$1', [req.params.id]);
    if (!rowCount) throw httpErr(404, 'richiesta inesistente');
    await pool.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1::uuid,'richiesta_rifiutata','richiesta',$2::text)`, [req.utente.id, req.params.id]);
    return { ok: true };
  });
}
