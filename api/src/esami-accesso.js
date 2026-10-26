import { accessoEvento, enteUtente } from './enti.js';
import { norm } from './comitati.js';

// Gli inviti sono nominativi e valgono soltanto per la sessione indicata.
export async function accessoSessione(db, u, s) {
  if (u.admin || u.ruolo === 'admin') return 'gestione';
  if (s.evento_id) {
    if ((u.eventi_org || []).includes(s.evento_id)) return 'gestione';
    if (!u.per_evento) {
      const { rows: [e] } = await db.query('select id, tipo, livello, comitato, regione from evento where id=$1', [s.evento_id]);
      // Un evento storico senza ente non rende gli esami pubblici allo staff.
      if (e?.livello && await accessoEvento(db, u, e) === 'scrittura') return 'gestione';
      if (e && !e.livello) {
        if (s.creato_da === u.id) return 'gestione';
        const mio = await enteUtente(db, u);
        if (s.comitato && mio.comitato && norm(s.comitato) === norm(mio.comitato)) return 'gestione';
      }
    }
  } else if (!u.per_evento) {
    if (s.creato_da === u.id) return 'gestione';
    const mio = await enteUtente(db, u);
    if (s.comitato && mio.comitato && norm(s.comitato) === norm(mio.comitato)) return 'gestione';
  }
  const { rowCount } = await db.query('select 1 from sessione_esame_invito where sessione_id=$1 and utente_id=$2', [s.id, u.id]);
  return rowCount ? 'valutazione' : null;
}
