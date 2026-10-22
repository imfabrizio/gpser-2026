// Libreria delle schede: generale (direzione) e private di un comitato (istruttori, manovre salvavita, monitori).
import { httpErr } from './services/compilazioni.js';

export const haSchede = (u) => !!u.admin || (u.aree || []).includes('schede');
export const haSchedeComitato = (u) => (u.aree || []).includes('formazione_esame');

export async function comitatoDi(pool, utente) {
  const { rows } = await pool.query('select comitato from partecipante where utente_id=$1 and comitato is not null limit 1', [utente.id]).catch(() => ({ rows: [] }));
  return rows[0]?.comitato ?? null;
}

// può leggere/modificare questa scheda? (modifica: la generale solo con l'area Schede, la privata solo il suo comitato; admin sempre)
export async function controllaScheda(pool, utente, id, { modifica }) {
  const { rows: [p] } = await pool.query('select id, comitato from patologia where id=$1', [id]);
  if (!p) throw httpErr(404, 'patologia inesistente');
  if (utente.admin) return p;
  if (!p.comitato) { if (modifica && !haSchede(utente)) throw httpErr(403, 'le schede generali le modifica solo la direzione'); return p; }
  if (!modifica && haSchede(utente)) return p;      // la direzione può guardare una scheda dei comitati (richiesta esplicita), non modificarla
  const mio = await comitatoDi(pool, utente);
  if (!haSchedeComitato(utente) || !mio || mio.trim().toLowerCase() !== p.comitato.trim().toLowerCase()) throw httpErr(403, 'scheda privata di un altro comitato');
  return p;
}
