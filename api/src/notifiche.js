// Notifiche nell'app, per utente (campanella in alto).
import { regioneDelComitato } from './enti.js';
export async function notifica(db, utenti, { tipo, titolo, testo = null, link = null }) {
  const ids = [...new Set([].concat(utenti).filter(Boolean))];
  for (const id of ids) await db.query('insert into notifica (utente_id, tipo, titolo, testo, link) values ($1,$2,$3,$4,$5)', [id, tipo, titolo, testo, link]);
}
export const adminIds = async (db) => (await db.query('select id from utente where attivo and admin')).rows.map((r) => r.id);
// chi può approvare per una regione: gli admin e chi ha l'area «approvazione» in un comitato di quella regione
export async function approvatoriIds(db, regione) {
  const { rows } = await db.query(
    `select u.id, u.admin, coalesce(p.comitato, u.comitato) as comitato from utente u left join ruolo r on r.codice=u.ruolo left join partecipante p on p.utente_id=u.id
      where u.attivo and (u.admin or 'approvazione' = any(r.aree))`);
  const ok = [];
  for (const u of rows) { if (u.admin || (u.comitato && (await regioneDelComitato(db, u.comitato)) === regione)) ok.push(u.id); }
  return ok;
}
export function registraNotifiche(app, pool) {
  app.get('/api/me/notifiche', async (req) => {
    const { rows } = await pool.query('select id, tipo, titolo, testo, link, letta, created_at from notifica where utente_id=$1 order by created_at desc limit 30', [req.utente.id]);
    return { non_lette: (await pool.query('select count(*)::int n from notifica where utente_id=$1 and not letta', [req.utente.id])).rows[0].n, elenco: rows };
  });
  app.post('/api/me/notifiche/lette', async (req) => {
    const id = req.body?.id;
    await pool.query(`update notifica set letta=true where utente_id=$1 and ($2::uuid is null or id=$2::uuid)`, [req.utente.id, id || null]);
    return { ok: true };
  });
}
