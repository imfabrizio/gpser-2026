// Enti proprietari del materiale: comitato → regione (per il Trentino-Alto Adige la singola provincia autonoma) → nazionale.
import { canonico, norm } from './comitati.js';

// chiave dell'ente regionale di un comitato (null se il comitato non è in elenco)
export const chiaveRegione = (c) => (!c?.regione ? null : (/^trentino/i.test(c.regione) && c.provincia ? `${c.regione} · ${c.provincia}` : c.regione));

export async function enteUtente(db, utente) {
  const { rows } = await db.query('select comitato from partecipante where utente_id=$1 and comitato is not null limit 1', [utente.id]).catch(() => ({ rows: [] }));
  const nome = rows[0]?.comitato ?? null; if (!nome) return { comitato: null, regione: null };
  const c = (await canonico(db, nome)).comitato;
  return { comitato: c?.nome ?? nome, regione: chiaveRegione(c) };
}
export const regioneDelComitato = async (db, nome) => (nome ? chiaveRegione((await canonico(db, nome)).comitato) : null);
export const èApprovatore = (u) => !!u.admin || (u.aree || []).includes('approvazione');

// può vedere questo evento? Gli eventi senza proprietario (storici) restano visibili a tutto lo staff; admin vede sempre tutto.
export async function puoVedereEvento(db, utente, evento) {
  if (utente.admin || utente.ruolo === 'admin' || !evento.livello) return true;
  if ((utente.eventi_org || []).includes(evento.id)) return true;
  const mio = await enteUtente(db, utente);
  if (evento.livello === 'comitato') return !!mio.comitato && norm(mio.comitato) === norm(evento.comitato);
  if (evento.livello === 'regione') return !!mio.regione && mio.regione === evento.regione;
  return false;   // nazionale: solo admin e chi è assegnato all'evento
}

// accesso a un evento: 'scrittura' (è del tuo ente o ti è assegnato), 'lettura' (il tuo comitato è invitato a un allenamento), null
export async function accessoEvento(db, utente, evento) {
  if (await puoVedereEvento(db, utente, evento)) return 'scrittura';
  if (evento.tipo === 'allenamento' || evento.livello === 'comitato') {
    const mio = await enteUtente(db, utente); if (!mio.comitato) return null;
    const { rows } = await db.query('select comitato from evento_comitato_invitato where evento_id=$1', [evento.id]);
    if (rows.some((r) => norm(r.comitato) === norm(mio.comitato))) return 'lettura';
  }
  return null;
}
