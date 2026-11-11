// Ambito di chi gestisce i corsi: trainer / monitore (locale: solo il proprio comitato), formatore / capo monitore (nazionale: tutta Italia).
// Le qualifiche valgono per il tipo di corso a cui servono (tabella tipo_corso): un trainer delle manovre salvavita non gestisce un corso TSSA.
// Un trainer di un altro comitato si invita al singolo evento. Admin e chi ha l'area «gara» gestiscono tutto.
import { norm } from './comitati.js';

export const TIPI_CORSO = ['corso', 'megacode', 'esame'];

export async function profiloFormativo(db, utenteId) {
  const { rows: [p] } = await db.query('select comitato from partecipante where utente_id=$1', [utenteId]);
  const { rows } = await db.query(
    `select q.codice, q.ambito from persona_qualifica pq join qualifica q on q.codice = pq.qualifica join partecipante p on p.id = pq.partecipante_id where p.utente_id=$1 and q.ambito is not null`, [utenteId]);
  return { comitato: p?.comitato || null, locale: rows.some((r) => r.ambito === 'locale'), nazionale: rows.some((r) => r.ambito === 'nazionale'), qualifiche: rows };
}

// tipo di corso di un evento: il suo, oppure quello del corso a cui appartiene (null per gli eventi che non sono formazione)
export async function tipoCorsoDi(db, eventoId) {
  if (!eventoId) return null;
  const { rows: [t] } = await db.query(
    `select t.codice, t.nome, t.docenti, t.valutatori from evento e left join evento c on c.id = e.corso_id join tipo_corso t on t.codice = coalesce(e.tipo_corso, c.tipo_corso) where e.id=$1`, [eventoId]);
  return t ?? null;
}
// cosa può fare una persona su un tipo di corso con le qualifiche che ha: nulla, solo nel proprio comitato (locale) o ovunque (nazionale)
export function dirittiSuTipo(prof, tipo) {
  if (!tipo) return { locale: !!prof.locale, nazionale: !!prof.nazionale };                    // evento senza tipo: vale qualunque qualifica di formazione
  const mie = (prof.qualifiche || []).filter((q) => tipo.docenti.includes(q.codice));
  return { locale: mie.some((q) => q.ambito === 'locale'), nazionale: mie.some((q) => q.ambito === 'nazionale') };
}

// chi ha solo l'area dei corsi (non «gara») vede e modifica soltanto i corsi nel suo ambito
export const soloFormazione = (u) => u.ruolo === 'organizzazione' && !(u.aree || []).includes('gara');

export async function puoGestireEvento(db, u, evento, prof) {
  if (u.ruolo === 'admin' || !soloFormazione(u)) return true;
  if (!TIPI_CORSO.includes(evento.tipo)) return false;
  prof = prof || await profiloFormativo(db, u.id);
  const d = dirittiSuTipo(prof, await tipoCorsoDi(db, evento.id));
  if (d.nazionale) return true;
  if ((await db.query('select 1 from evento_invito where evento_id=$1 and utente_id=$2 and stato=\'attivo\'', [evento.id, u.id])).rowCount) return true;
  if (evento.corso_id) {                                    // Mega Code ed esami seguono il corso
    const { rows: [c] } = await db.query('select id, tipo, comitato, corso_id from evento where id=$1', [evento.corso_id]);
    if (c && c.id !== evento.id && await puoGestireEvento(db, u, c, prof)) return true;
  }
  return !!(d.locale && prof.comitato && evento.comitato && norm(prof.comitato) === norm(evento.comitato));
}
