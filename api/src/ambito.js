// Ambito di chi gestisce i corsi: trainer / monitore (locale: solo il proprio comitato), formatore / capo monitore (nazionale: tutta Italia).
// Un trainer di un altro comitato si invita al singolo evento. Admin e chi ha l'area «gara» gestiscono tutto.
import { norm } from './comitati.js';

export const TIPI_CORSO = ['corso', 'megacode', 'esame'];

export async function profiloFormativo(db, utenteId) {
  const { rows: [p] } = await db.query('select comitato from partecipante where utente_id=$1', [utenteId]);
  const { rows } = await db.query(
    `select q.ambito from persona_qualifica pq join qualifica q on q.codice = pq.qualifica join partecipante p on p.id = pq.partecipante_id where p.utente_id=$1 and q.ambito is not null`, [utenteId]);
  return { comitato: p?.comitato || null, locale: rows.some((r) => r.ambito === 'locale'), nazionale: rows.some((r) => r.ambito === 'nazionale') };
}

// chi ha solo l'area dei corsi (non «gara») vede e modifica soltanto i corsi nel suo ambito
export const soloFormazione = (u) => u.ruolo === 'organizzazione' && !(u.aree || []).includes('gara');

export async function puoGestireEvento(db, u, evento, prof) {
  if (u.ruolo === 'admin' || !soloFormazione(u)) return true;
  if (!TIPI_CORSO.includes(evento.tipo)) return false;
  prof = prof || await profiloFormativo(db, u.id);
  if (prof.nazionale) return true;
  if ((await db.query('select 1 from evento_invito where evento_id=$1 and utente_id=$2', [evento.id, u.id])).rowCount) return true;
  if (evento.corso_id) {                                    // Mega Code ed esami seguono il corso
    const { rows: [c] } = await db.query('select id, tipo, comitato, corso_id from evento where id=$1', [evento.corso_id]);
    if (c && c.id !== evento.id && await puoGestireEvento(db, u, c, prof)) return true;
  }
  return !!(prof.locale && prof.comitato && evento.comitato && norm(prof.comitato) === norm(evento.comitato));
}
