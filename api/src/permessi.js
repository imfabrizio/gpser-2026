// Ruoli e aree della Gestione. Un utente ha un ruolo (con le sue aree) e, se serve, la spunta "admin" che dà accesso a tutto.
export const AREE = {
  gara: 'Gara', scene: 'Scene', schede: 'Schede', squadre: 'Squadre', notizie: 'Notizie', anagrafiche: 'Anagrafiche',
  classifiche: 'Classifiche', stampa: 'Stampa', importa: 'Importa', approvazione: 'Approvazione', segreteria: 'Segreteria', valutazione: 'Valutazione', accompagnatore: 'Accompagnatore', documentazione: 'Documentazione', formazione_esame: 'Formazione d\'esame', esami: 'Esami',
};   // Utenti, Ruoli e Richieste restano riservati agli admin

// ruolo "efficace" usato dai controlli: admin > staff (ruolo con almeno un'area) > giudice / giudice master > partecipante (nessun potere)
const gestione = (u) => (u.aree || []).filter((a) => a !== 'valutazione' && a !== 'accompagnatore');   // «valutazione» da sola non dà accesso alla Gestione
export const eStaff = (u) => !!u.admin || gestione(u).length > 0;
export const ruoloEffettivo = (u) => u.admin ? 'admin' : gestione(u).length ? 'organizzazione'
  : (u.aree || []).includes('valutazione') ? (u.ruolo === 'giudice_master' || (u.ruoli_extra || []).includes('giudice_master') ? 'giudice_master' : 'giudice')
  : (u.ev_ruoli || []).some((r) => r.ruolo === 'giudice_master') ? 'giudice_master' : (u.ev_ruoli || []).length ? 'giudice' : 'partecipante';

// quali aree aprono quali rotte (metodo, pattern della rotta Fastify) — basta averne una
const R = (m, rotta, aree) => [new RegExp(`^(${m})$`), new RegExp(`^${rotta}$`), aree];
const REGOLE = [
  R('GET', '/api/scene/:id/turno', ['gara', 'scene', 'valutazione']),
  R('POST', '/api/scene/:id/(apri|chiudi)', ['gara', 'scene', 'valutazione']),
  R('POST', '/api/compilazioni/:id/riapri', ['valutazione']), R('DELETE', '/api/compilazioni/:id', ['valutazione']),
  R('PUT', '/api/persone/:id/qualifiche', ['anagrafiche']),
  R('POST|DELETE', '/api/avvisi(/:id)?', ['notizie']),
  R('POST|PATCH', '/api/eventi(/:id)?', ['gara', 'esami']), R('POST', '/api/eventi/:id/attiva', ['gara']), R('PUT', '/api/eventi/:id/(ente|data-fine|posizione)', ['gara', 'esami']), R('GET|POST', '/api/eventi/:id/(inviti|invitabili)', ['gara', 'esami']), R('DELETE', '/api/eventi/:id/inviti/:utente', ['gara', 'esami']),
  R('POST', '/api/eventi/:id/squadre', ['squadre']), R('GET|POST', '/api/eventi/:id/discenti', ['squadre', 'esami']), R('DELETE', '/api/eventi/:id/discenti/:pid', ['squadre', 'esami']), R('POST', '/api/eventi/:id/collega-canovacci', ['scene']), R('PATCH', '/api/squadre/:id', ['squadre']), R('GET|PUT', '/api/squadre/:id/membri', ['squadre', 'anagrafiche']),
  R('POST', '/api/eventi/:id/scene', ['scene']), R('POST', '/api/scene/:id/(duplica|schede|elenco-pazienti|promozione)', ['scene']), R('PATCH|DELETE', '/api/scene/:id', ['scene']),
  R('PUT|DELETE', '/api/schede/:id/voci/:ordine', ['scene']), R('POST', '/api/schede/:id/voci', ['scene']), R('PUT', '/api/schede/:id/sezione', ['scene']), R('GET', '/api/schede/:id/anteprima.pdf', ['scene']), R('PATCH|DELETE', '/api/schede/:id', ['scene']), R('PUT', '/api/schede/:id/assegnazioni', ['scene']),
  R('GET', '/api/eventi/:id/(assegnazioni|master)', ['scene']), R('GET|PUT', '/api/eventi/:id/rotazione', ['gara', 'scene']), R('PUT', '/api/scene/:id/master', ['scene']), R('GET', '/api/giudici', ['scene']),
  R('GET', '/api/libreria/(scale|voci|patologie(/:id)?)', ['schede', 'scene', 'formazione_esame']), R('POST', '/api/libreria/scale', ['schede']), R('POST', '/api/libreria/patologie', ['schede', 'formazione_esame']),
  R('GET', '/api/ai/stato', ['schede', 'formazione_esame']), R('POST', '/api/libreria/genera', ['schede', 'formazione_esame']), R('POST', '/api/libreria/patologie/:id/pubblica', ['schede', 'formazione_esame']),
  R('PUT|DELETE', '/api/libreria/patologie/:id', ['schede', 'formazione_esame']),
  R('GET', '/api/eventi/:id/(classifica|classifica.pdf|monitor|avanzamento)', ['classifiche']), R('GET', '/api/eventi/:id/stampa.pdf', ['stampa', 'esami']), R('GET', '/api/eventi/:id/storico', ['esami', 'classifiche']), R('POST', '/api/eventi/:id/esiti-pubblicati', ['esami']), R('GET', '/api/eventi/:id/statistiche', ['esami', 'classifiche']),
  R('POST', '/api/sync', ['valutazione']), R('GET', '/api/compilazioni', ['valutazione']), R('GET', '/api/schede/:id/esito.pdf', ['valutazione']), R('GET', '/api/schede/:id', ['valutazione', 'scene']),
  R('POST|PATCH|DELETE', '/api/documenti(/:id)?', ['documentazione']),
  R('GET|POST|PATCH|PUT|DELETE', '/api/esami/.*', ['esami']), R('GET|POST|PATCH|PUT|DELETE', '/api/esami', ['esami']),
  R('POST', '/api/iscrizioni/:id/accesso', ['scene', 'segreteria']), R('GET', '/api/eventi/:id/risorse', ['scene']), R('PUT', '/api/scene/:id/risorse', ['scene']),
  R('GET|POST|PATCH|DELETE', '/api/eventi/:id/iscritti(/da-squadre)?', ['segreteria']), R('PATCH|DELETE', '/api/iscritti/:id', ['segreteria']), R('POST', '/api/iscritti/:id/(arrivo|annulla-arrivo)', ['segreteria']),
  R('GET', '/api/eventi/:id/badge.pdf', ['segreteria']), R('PUT', '/api/eventi/:id/formato-badge', ['segreteria']), R('GET', '/api/segreteria/persone', ['segreteria']),
  R('GET|POST|DELETE', '/api/badge/formati(/:id)?', ['segreteria']),
  R('GET|POST|PATCH|DELETE', '/api/comitati(/:id|/importa|/da-ricondurre|/ricondurre)?', ['anagrafiche']),
  R('GET|PUT', '/api/eventi/:id/comitati-invitati', ['gara']), R('GET', '/api/libreria/doppioni', ['schede', 'approvazione']), R('GET', '/api/libreria/(confronta|patologie/:id/revisioni)', ['schede', 'scene', 'formazione_esame']), R('GET|PUT', '/api/libreria/patologie/:id/skill', ['schede', 'formazione_esame']), R('GET|POST', '/api/libreria/raggruppamenti', ['schede', 'approvazione']), R('POST', '/api/schede/:id/revisione', ['scene']), R('POST', '/api/libreria/doppioni/ignora', ['schede', 'approvazione']), R('POST', '/api/libreria/patologie/:id/unisci', ['schede', 'approvazione']),
  R('GET', '/api/(promozioni|catalogo|regioni)', ['scene', 'schede', 'formazione_esame', 'approvazione']), R('POST', '/api/promozioni/:id/ritira', ['scene', 'schede', 'formazione_esame']), R('POST', '/api/promozioni/:id/(approva|rifiuta)', ['approvazione']), R('PUT', '/api/condivisione/:tipo/:id(/ricevuta)?', ['approvazione']),
  R('POST', '/api/libreria/patologie/:id/proponi', ['schede', 'formazione_esame']), R('GET', '/api/scene-condivise', ['scene', 'approvazione']), R('POST', '/api/scene-condivise/:id/copia', ['scene']),
  R('POST', '/api/import/(excel|canovacci)', ['importa']), R('DELETE|PATCH', '/api/canovacci/:id', ['importa']), R('PUT', '/api/canovacci/:id', ['importa', 'scene']), R('POST', '/api/canovacci', ['importa', 'scene']), R('POST', '/api/canovacci/esempi-megacode', ['importa']), R('POST', '/api/canovacci/codici-mancanti', ['importa']), R('GET', '/api/canovacci(/:id(/canovaccio.pdf)?)?', ['scene', 'schede', 'formazione_esame', 'importa']), R('GET|POST|PATCH|DELETE', '/api/persone(/:id)?', ['anagrafiche']),
];
// null = rotta non vincolata a un'area (la decidono i controlli della rotta stessa)
export function areeRichieste(metodo, rotta) {
  const r = REGOLE.find(([m, p]) => m.test(metodo) && p.test(rotta));
  return r ? r[2] : null;
}
