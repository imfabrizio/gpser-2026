// Libreria delle schede: generale (direzione) e private di un comitato (istruttori, manovre salvavita, monitori).
import { httpErr } from './services/compilazioni.js';
import { enteUtente, èApprovatore } from './enti.js';

export const haSchede = (u) => !!u.admin || (u.aree || []).includes('schede');
export const haSchedeComitato = (u) => (u.aree || []).includes('formazione_esame');

export async function comitatoDi(pool, utente) {
  const { rows } = await pool.query('select comitato from partecipante where utente_id=$1 and comitato is not null limit 1', [utente.id]).catch(() => ({ rows: [] }));
  return rows[0]?.comitato ?? null;
}

// può leggere/modificare questa scheda? (modifica: la generale solo con l'area Schede, la privata solo il suo comitato; admin sempre)
export async function controllaScheda(pool, utente, id, { modifica }) {
  const { rows: [p] } = await pool.query('select id, comitato, regione from patologia where id=$1', [id]);
  if (!p) throw httpErr(404, 'patologia inesistente');
  if (utente.admin) return p;
  if (p.regione) {                                   // scheda del catalogo di una regione: la modifica l'approvatore della regione proprietaria; la legge chi la riceve
    const reg = (await enteUtente(pool, utente)).regione, appr = èApprovatore(utente);
    if (modifica) { if (appr && reg === p.regione) return p; throw httpErr(403, 'la scheda è del catalogo di una regione: la modifica solo il suo approvatore'); }
    const { rows } = await pool.query('select comitati from condivisione where tipo=\'patologia\' and risorsa_id=$1 and regione=$2', [id, reg]);
    if (rows.length && (appr || rows[0].comitati)) return p;
    throw httpErr(403, 'scheda non disponibile per la tua regione');
  }
  if (!p.comitato) { if (modifica && !haSchede(utente)) throw httpErr(403, 'le schede generali le modifica solo la direzione'); return p; }
  if (!modifica && haSchede(utente)) return p;      // la direzione può guardare una scheda dei comitati (richiesta esplicita), non modificarla
  const mio = await comitatoDi(pool, utente);
  if (!haSchedeComitato(utente) || !mio || mio.trim().toLowerCase() !== p.comitato.trim().toLowerCase()) throw httpErr(403, 'scheda privata di un altro comitato');
  return p;
}

// tipologie d'uso di una scheda: a quali eventi si può proporre (gara, Olimpiadi, Mega Code, esami e skill)
export const TIPOLOGIE = ['gara', 'olimpiadi', 'megacode', 'skill'];
export function tipologieValide(v, predefinito) {
  if (v === undefined || v === null) return predefinito;
  const l = [...new Set((Array.isArray(v) ? v : []).filter((x) => TIPOLOGIE.includes(x)))];
  if (!l.length) throw httpErr(400, 'scegli almeno una tipologia: gara, olimpiadi, megacode o skill');
  return l;
}
