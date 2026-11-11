// Chi gestisce i corsi. L'ambito sta sul TIPO DI CORSO (tabella tipo_corso), non sulla persona:
//   regionale (TSSA, manovre salvavita): chi ha la qualifica apre il corso nel proprio comitato; per un altro comitato della sua
//             regione serve la delega approvata dalla formazione regionale; fuori regione non si opera.
//   nazionale (primo soccorso, DU, corsi per trainer): si apre per qualunque comitato.
// Il formatore è anche trainer: sta tra i docenti dei corsi per operatori e, da solo, tra quelli dei corsi per trainer.
// Ogni corso ha un direttore (chi lo apre, o chi riceve l'incarico) che sceglie i docenti. Admin e chi ha l'area «gara» gestiscono tutto.
import { norm } from './comitati.js';
import { regioneDelComitato } from './enti.js';

export const TIPI_CORSO = ['corso', 'megacode', 'esame'];
export const AREA_FORMAZIONE_REGIONE = 'formazione_regione';   // formazione regionale: approva le deleghe e segue i corsi della propria regione

export async function profiloFormativo(db, utenteId) {
  const { rows: [p] } = await db.query('select comitato from partecipante where utente_id=$1', [utenteId]);
  const { rows } = await db.query(
    `select q.codice from persona_qualifica pq join qualifica q on q.codice = pq.qualifica join partecipante p on p.id = pq.partecipante_id where p.utente_id=$1 and q.ambito is not null`, [utenteId]);
  return { comitato: p?.comitato || null, qualifiche: rows.map((r) => r.codice) };
}

// tipo di corso di un evento: il suo, oppure quello del corso a cui appartiene (null per gli eventi che non sono formazione)
export async function tipoCorsoDi(db, eventoId) {
  if (!eventoId) return null;
  const { rows: [t] } = await db.query(
    `select t.codice, t.nome, t.docenti, t.valutatori, t.ambito from evento e left join evento c on c.id = e.corso_id join tipo_corso t on t.codice = coalesce(e.tipo_corso, c.tipo_corso) where e.id=$1`, [eventoId]);
  return t ?? null;
}
// la persona ha una qualifica da docente per quel tipo di corso? (evento senza tipo: basta una qualifica di formazione)
export const docenteDelTipo = (prof, tipo) => (tipo ? (prof.qualifiche || []).some((q) => tipo.docenti.includes(q)) : (prof.qualifiche || []).length > 0);

// chi ha solo l'area dei corsi (non «gara») vede e modifica soltanto i corsi nel suo ambito
export const soloFormazione = (u) => u.ruolo === 'organizzazione' && !(u.aree || []).includes('gara');
export const formazioneRegionale = (u) => !!u.admin || (u.aree || []).includes(AREA_FORMAZIONE_REGIONE);

export async function puoGestireEvento(db, u, evento, prof) {
  if (u.ruolo === 'admin' || !soloFormazione(u)) return true;
  if (!TIPI_CORSO.includes(evento.tipo)) return false;
  prof = prof || await profiloFormativo(db, u.id);
  const stessaRegione = async () => { const mia = prof.comitato && await regioneDelComitato(db, prof.comitato); return !!mia && !!evento.comitato && mia === await regioneDelComitato(db, evento.comitato); };
  if (formazioneRegionale(u) && await stessaRegione()) return true;                                  // la formazione regionale segue i corsi della sua regione
  const { rows: [x] } = await db.query(
    `select e.direttore_id, exists (select 1 from evento_invito i where i.evento_id=e.id and i.utente_id=$2 and i.stato='attivo') as invitato from evento e where e.id=$1`, [evento.id, u.id]);
  if (x && (x.direttore_id === u.id || x.invitato)) return true;                                      // direttore del corso, o docente chiamato dal direttore
  if (evento.corso_id) {                                    // Mega Code ed esami seguono il corso
    const { rows: [c] } = await db.query('select id, tipo, comitato, corso_id from evento where id=$1', [evento.corso_id]);
    if (c && c.id !== evento.id && await puoGestireEvento(db, u, c, prof)) return true;
  }
  // i docenti del comitato che organizza il corso, con la qualifica prevista dal tipo
  return !!(prof.comitato && evento.comitato && norm(prof.comitato) === norm(evento.comitato) && docenteDelTipo(prof, await tipoCorsoDi(db, evento.id)));
}
