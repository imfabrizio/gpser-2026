// Ruoli e aree della Gestione. Un utente ha un ruolo (con le sue aree) e, se serve, la spunta "admin" che dà accesso a tutto.
export const AREE = {
  gara: 'Gara', scene: 'Scene', schede: 'Schede', squadre: 'Squadre', notizie: 'Notizie', anagrafiche: 'Anagrafiche',
  classifiche: 'Classifiche', stampa: 'Stampa', importa: 'Importa', segreteria: 'Segreteria', valutazione: 'Valutazione', documentazione: 'Documentazione', formazione_esame: 'Formazione d\'esame', esami: 'Esami',
};   // Utenti, Ruoli e Richieste restano riservati agli admin

// ruolo "efficace" usato dai controlli: admin > staff (ruolo con almeno un'area) > giudice / giudice master > partecipante (nessun potere)
const gestione = (u) => (u.aree || []).filter((a) => a !== 'valutazione');   // «valutazione» da sola non dà accesso alla Gestione
export const eStaff = (u) => !!u.admin || gestione(u).length > 0;
export const ruoloEffettivo = (u) => u.admin ? 'admin' : gestione(u).length ? 'organizzazione'
  : (u.aree || []).includes('valutazione') ? (u.ruolo === 'giudice_master' ? 'giudice_master' : 'giudice') : 'partecipante';

// quali aree aprono quali rotte (metodo, pattern della rotta Fastify) — basta averne una
const R = (m, rotta, aree) => [new RegExp(`^(${m})$`), new RegExp(`^${rotta}$`), aree];
const REGOLE = [
  R('POST|DELETE', '/api/avvisi(/:id)?', ['notizie']),
  R('POST|PATCH', '/api/eventi(/:id)?', ['gara']), R('POST', '/api/eventi/:id/attiva', ['gara']),
  R('POST', '/api/eventi/:id/squadre', ['squadre']), R('PATCH', '/api/squadre/:id', ['squadre']), R('GET|PUT', '/api/squadre/:id/membri', ['squadre', 'anagrafiche']),
  R('POST', '/api/eventi/:id/scene', ['scene']), R('POST', '/api/scene/:id/(duplica|schede)', ['scene']), R('PATCH|DELETE', '/api/scene/:id', ['scene']),
  R('PUT', '/api/schede/:id/voci/:ordine', ['scene']), R('PATCH|DELETE', '/api/schede/:id', ['scene']), R('PUT', '/api/schede/:id/assegnazioni', ['scene']),
  R('GET', '/api/eventi/:id/(assegnazioni|master)', ['scene']), R('PUT', '/api/scene/:id/master', ['scene']), R('GET', '/api/giudici', ['scene']),
  R('GET', '/api/libreria/(scale|voci|patologie(/:id)?)', ['schede', 'scene', 'formazione_esame']), R('POST', '/api/libreria/scale', ['schede']), R('POST', '/api/libreria/patologie', ['schede', 'formazione_esame']),
  R('PUT|DELETE', '/api/libreria/patologie/:id', ['schede', 'formazione_esame']),
  R('GET', '/api/eventi/:id/(classifica|classifica.pdf|monitor)', ['classifiche']), R('GET', '/api/eventi/:id/stampa.pdf', ['stampa']),
  R('POST', '/api/sync', ['valutazione']), R('GET', '/api/compilazioni', ['valutazione']), R('GET', '/api/schede/:id/esito.pdf', ['valutazione']), R('GET', '/api/schede/:id', ['valutazione', 'scene']),
  R('POST|PATCH|DELETE', '/api/documenti(/:id)?', ['documentazione']),
  R('GET|POST|PATCH|PUT|DELETE', '/api/esami/.*', ['esami']), R('GET|POST|PATCH|PUT|DELETE', '/api/esami', ['esami']),
  R('GET', '/api/eventi/:id/risorse', ['scene']), R('PUT', '/api/scene/:id/risorse', ['scene']),
  R('GET|POST|PATCH|DELETE', '/api/eventi/:id/iscritti(/da-squadre)?', ['segreteria']), R('PATCH|DELETE', '/api/iscritti/:id', ['segreteria']), R('POST', '/api/iscritti/:id/(arrivo|annulla-arrivo)', ['segreteria']),
  R('GET', '/api/eventi/:id/badge.pdf', ['segreteria']), R('PUT', '/api/eventi/:id/formato-badge', ['segreteria']), R('GET', '/api/segreteria/persone', ['segreteria']),
  R('GET|POST|DELETE', '/api/badge/formati(/:id)?', ['segreteria']),
  R('POST', '/api/import/excel', ['importa']), R('GET|POST|PATCH|DELETE', '/api/persone(/:id)?', ['anagrafiche']),
];
// null = rotta non vincolata a un'area (la decidono i controlli della rotta stessa)
export function areeRichieste(metodo, rotta) {
  const r = REGOLE.find(([m, p]) => m.test(metodo) && p.test(rotta));
  return r ? r[2] : null;
}
