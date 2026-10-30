// Modalità offline del tablet: pacchetto cifrato in IndexedDB, sblocco con il codice del giudice, valutazioni salvate in locale e inviate al rientro.
const NOME_DB = 'gpser_offline', ARCHIVIO = 'kv';
const aprilo = () => new Promise((ok, ko) => { const r = indexedDB.open(NOME_DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(ARCHIVIO); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
const tx = async (modo, fn) => { const d = await aprilo(); return new Promise((ok, ko) => { const t = d.transaction(ARCHIVIO, modo), s = t.objectStore(ARCHIVIO); const r = fn(s); t.oncomplete = () => ok(r && 'result' in r ? r.result : undefined); t.onerror = () => ko(t.error); t.onabort = () => ko(t.error); }); };
export const leggi = (k) => tx('readonly', (s) => s.get(k));
export const scrivi = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const togli = (k) => tx('readwrite', (s) => s.delete(k));

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
async function apri(blob, codice) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(norm(codice)), 'PBKDF2', false, ['deriveKey']);
  const chiave = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(blob.salt), iterations: blob.iter || 100000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(blob.iv) }, chiave, b64(blob.ct)));
}

export function idDispositivo() { let id = null; try { id = localStorage.getItem('dev_id'); } catch { /* niente */ } if (!id) { id = crypto.randomUUID(); try { localStorage.setItem('dev_id', id); } catch { /* niente */ } } return id; }
const tipoSchermo = () => { const ua = navigator.userAgent, l = Math.min(screen.width, screen.height); return /iPad|Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)) ? 'tablet' : /Mobile|iPhone|Android/i.test(ua) || l < 500 ? 'telefono' : 'computer'; };
export const registraDispositivo = (api) => api('/dispositivi/registra', { body: { id: idDispositivo(), tipo: tipoSchermo(), larghezza: Math.min(screen.width, screen.height) } }).catch(() => null);

export const pacchetto = () => leggi('pacchetto');
export async function prepara(api, eventoId) {
  const p = await api(`/eventi/${eventoId}/offline/pacchetto`, { body: { dispositivo_id: idDispositivo() } });
  await scrivi('pacchetto', p); if (!(await leggi('locale'))) await scrivi('locale', {});
  try { await navigator.storage?.persist?.(); } catch { /* il browser può rifiutare */ }
  return p;
}

// sessione sbloccata (solo in memoria: ricaricando la pagina si inserisce di nuovo il codice)
let sessione = null;
export const sessioneAttiva = () => sessione;
export async function sblocca(codice) {
  const p = await pacchetto(); if (!p) throw new Error('questo tablet non è preparato');
  for (const g of p.giudici) {
    try { const dati = JSON.parse(await apri(g, codice)); const locale = (await leggi('locale')) || {};
      sessione = { dati, utente: dati.utente, pacchetto: p, locale }; return sessione; } catch { /* codice di un altro: si prova il prossimo */ }
  }
  throw new Error('codice non valido');
}
export function blocca() { sessione = null; }
async function verificaCodiceMaster(codice) {
  const p = sessione.pacchetto;
  for (const m of p.riaperture || []) { try { if ((await apri(m, codice)) === 'ok') return m; } catch { /* altro master */ } }
  return null;
}

const chiave = (s, q) => `${s}|${q}`;
// stato locale di una scheda/squadra = istantanea del server al momento della preparazione + ciò che è stato fatto dopo
function composta(s, q) {
  const snap = sessione.dati.compilazioni[chiave(s, q)], loc = sessione.locale[chiave(s, q)];
  const risposte = new Map((snap?.risposte || []).map((r) => [r.voce_id, { voce_id: r.voce_id, livello: r.livello, updated_at: r.updated_at }]));
  if (loc) for (const [v, p] of Object.entries(loc.risposte || {})) { if (p.livello === null) risposte.delete(v); else risposte.set(v, { voce_id: v, livello: p.livello, updated_at: p.updated_at }); }
  const stato = loc?.stato ?? snap?.compilazione?.stato ?? 'bozza';
  const id = loc?.id || snap?.compilazione?.id || null;
  const esiste = !!(snap?.compilazione || loc);
  return { id, stato, esiste, risposte: [...risposte.values()], giudice: loc ? sessione.utente.nome : snap?.compilazione?.giudice };
}
export const statoScheda = (s, q) => { const c = composta(s, q); return !c.esiste ? 'da fare' : c.stato === 'bozza' ? 'in corso' : 'chiusa'; };
const salvaLocale = () => scrivi('locale', sessione.locale);

// le richieste che la schermata di valutazione farebbe al server vengono servite dal pacchetto
export async function apiOffline(path, opt = {}) {
  if (!sessione) return undefined;
  const metodo = opt.method || (opt.body ? 'POST' : 'GET');
  let m;
  if (metodo === 'GET' && (m = /^\/schede\/([0-9a-f-]{36})$/i.exec(path))) { const s = sessione.dati.schede[m[1]]; if (!s) throw new Error('scheda non presente su questo tablet'); return s; }
  if (metodo === 'GET' && /^\/eventi\/[0-9a-f-]{36}\/squadre$/i.test(path)) return sessione.dati.squadre;
  if (metodo === 'GET' && path.startsWith('/compilazioni?')) {
    const q = new URLSearchParams(path.split('?')[1]); const c = composta(q.get('scheda'), q.get('squadra'));
    const chiusa = c.stato !== 'bozza';
    return { compilazione: c.esiste ? { id: c.id, stato: c.stato, giudice: c.giudice || sessione.utente.nome } : null, risposte: c.risposte,
      ruolo_qui: sessione.utente.master ? 'master' : 'giudice', puo_modificare: !chiusa, puo_riaprire: chiusa };
  }
  if (metodo === 'POST' && path === '/sync') {
    const p = opt.body, k = chiave(p.scheda_id, p.squadra_id);
    if (!sessione.dati.schede[p.scheda_id]) throw Object.assign(new Error('scheda non assegnata a questo tablet'), { stato: 403 });
    const cur = composta(p.scheda_id, p.squadra_id);
    if (cur.stato !== 'bozza') throw Object.assign(new Error('scheda chiusa: la riapre il giudice master con il suo codice'), { stato: 409 });
    const e = sessione.locale[k] || (sessione.locale[k] = { id: cur.id || p.id, utente_id: sessione.utente.id, risposte: {}, riaperture: [] });
    for (const r of p.risposte || []) { const prima = e.risposte[r.voce_id]; if (!prima || prima.updated_at <= r.updated_at) e.risposte[r.voce_id] = { livello: r.livello, updated_at: r.updated_at || new Date().toISOString() }; }
    if (p.stato) { e.stato = 'verificata'; e.chiusa_il = new Date().toISOString(); }
    await salvaLocale();
    return [{ compilazione_id: e.id, stato: e.stato || 'bozza', scritte: (p.risposte || []).length, scartate: 0 }];
  }
  if (metodo === 'POST' && (m = /^\/compilazioni\/([^/]+)\/riapri$/.exec(path))) {
    const k = Object.keys(sessione.locale).find((x) => sessione.locale[x].id === m[1]) || Object.keys(sessione.dati.compilazioni).find((x) => sessione.dati.compilazioni[x].compilazione?.id === m[1]);
    if (!k) throw new Error('scheda non trovata');
    const codice = window.prompt('Codice del giudice master per riaprire la scheda:'); if (!codice) throw new Error('riapertura annullata');
    const master = await verificaCodiceMaster(codice); if (!master) throw new Error('codice del master non valido');
    const e = sessione.locale[k] || (sessione.locale[k] = { id: m[1], utente_id: sessione.utente.id, risposte: {}, riaperture: [] });
    e.stato = 'bozza'; (e.riaperture ||= []).push({ master_id: master.utente_id, master: master.nome, quando: new Date().toISOString() });
    await salvaLocale(); return { ok: true };
  }
  throw new Error('non disponibile in modalità offline');
}
export const inviaLocale = (payload) => apiOffline('/sync', { body: payload });

// riepilogo di ciò che c'è da inviare
export async function daInviare() {
  const loc = (await leggi('locale')) || {}; const l = Object.entries(loc).filter(([, e]) => Object.keys(e.risposte || {}).length || e.stato);
  return { schede: l.length, voci: l.reduce((n, [, e]) => n + Object.keys(e.risposte || {}).length, 0), chiuse: l.filter(([, e]) => e.stato).length };
}
async function costruisciInvii() {
  const loc = (await leggi('locale')) || {}, invii = [];
  for (const [k, e] of Object.entries(loc)) {
    const [scheda_id, squadra_id] = k.split('|');
    if (!Object.keys(e.risposte || {}).length && !e.stato) continue;
    invii.push({ utente_id: e.utente_id, riaperture: (e.riaperture || []).map((r) => ({ master_id: r.master_id })),
      payload: { id: e.id, scheda_id, squadra_id, stato: e.stato === 'verificata' ? 'completata' : undefined, risposte: Object.entries(e.risposte || {}).map(([voce_id, p]) => ({ voce_id, ...p })) } });
  }
  return invii;
}
// invio al ritorno online (serve l'accesso della direzione gara): solo dopo la conferma del server i dati vengono archiviati
export async function sincronizza(api) {
  const p = await pacchetto(); if (!p) throw new Error('nessun dato da inviare');
  const invii = await costruisciInvii();
  const r = await api('/offline/sync', { body: { evento_id: p.evento.id, dispositivo_id: idDispositivo(), invii } });
  if (r.errori === 0) {
    const arch = (await leggi('archivio')) || []; arch.push({ quando: new Date().toISOString(), evento: p.evento, invii: await costruisciInvii() });
    await scrivi('archivio', arch.slice(-20)); await scrivi('locale', {}); sessione = null;
  }
  return r;
}
export async function esporta() {
  const p = await pacchetto(); const dati = { esportato_il: new Date().toISOString(), evento: p?.evento, dispositivo_id: idDispositivo(), invii: await costruisciInvii() };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(dati, null, 1)], { type: 'application/json' }));
  a.download = `valutazioni-offline-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
export async function dimentica() { await togli('pacchetto'); await scrivi('locale', {}); sessione = null; }
