// Coda di salvataggio locale. Regole:
//  * ogni tocco è scritto SUBITO su disco (localStorage) prima di qualunque invio
//  * dopo un invio riuscito si cancella solo ciò che è stato davvero inviato e non è cambiato nel frattempo
//  * gli invii sono serializzati: una richiesta fatta durante un invio viene eseguita dopo, mai persa
//  * errori di rete / 5xx / 401 / 429: i dati restano in coda e si riprova
//  * errori 4xx "definitivi": i dati NON vengono cancellati ma spostati in `rifiutate` (visibili, ripristinabili)
//  * id compilazione in conflitto: si genera un UUID nuovo e si rimanda
//  * la coda è legata all'utente (chiave diversa per ogni account): nessuna attribuzione errata
export function creaCoda({ storage, invia, chiave = 'coda_v2', nuovoId = () => crypto.randomUUID() }) {
  const leggi = () => { try { const o = JSON.parse(storage.getItem(chiave) || 'null'); return { schede: o?.schede || {}, rifiutate: o?.rifiutate || [] }; } catch { return { schede: {}, rifiutate: [] }; } };
  const salva = (o) => storage.setItem(chiave, JSON.stringify(o));
  const copia = (x) => JSON.parse(JSON.stringify(x));

  function voce(k, meta, voceId, livello, ts = new Date().toISOString()) {
    const o = leggi();
    const e = o.schede[k] || (o.schede[k] = { id: meta.id || nuovoId(), scheda_id: meta.scheda_id, squadra_id: meta.squadra_id, risposte: {} });
    e.risposte = e.risposte || {};
    e.risposte[voceId] = { livello, updated_at: ts };
    salva(o);
  }
  function stato(k, meta, st) {
    const o = leggi();
    const e = o.schede[k] || (o.schede[k] = { id: meta.id || nuovoId(), scheda_id: meta.scheda_id, squadra_id: meta.squadra_id, risposte: {} });
    e.stato = st;
    salva(o);
  }
  const pendenti = (k) => copia(leggi().schede[k]?.risposte || {});
  const idPer = (k) => leggi().schede[k]?.id || null;
  const conta = () => { const o = leggi(); return { inCoda: Object.values(o.schede).reduce((n, e) => n + Object.keys(e.risposte || {}).length + (e.stato ? 1 : 0), 0), rifiutate: o.rifiutate.length }; };

  function rimuoviInviati(k, snap) {
    const o = leggi(); const e = o.schede[k];
    if (e) {
      for (const [v, p] of Object.entries(snap.risposte || {})) if (e.risposte?.[v]?.updated_at === p.updated_at && e.risposte[v].livello === p.livello) delete e.risposte[v];
      if (snap.stato && e.stato === snap.stato) delete e.stato;
      if (!Object.keys(e.risposte || {}).length && !e.stato) delete o.schede[k];
    }
    salva(o);
  }

  async function passata() {
    const r = { ok: true, errori: [], scartate: 0, rifiutate: 0 };
    for (const k of Object.keys(leggi().schede)) {
      for (let tentativo = 0; tentativo < 2; tentativo++) {
        const e = leggi().schede[k]; if (!e) break;
        const snap = copia(e); const voci = Object.entries(snap.risposte || {});
        if (!voci.length && !snap.stato) { rimuoviInviati(k, snap); break; }
        try {
          const esiti = await invia({ id: snap.id, scheda_id: snap.scheda_id, squadra_id: snap.squadra_id, stato: snap.stato,
            risposte: voci.map(([voce_id, p]) => ({ voce_id, ...p })) });
          r.scartate += (esiti || []).reduce((n, x) => n + (x.scartate || 0), 0);
          rimuoviInviati(k, snap);
          break;
        } catch (err) {
          const st = err.stato;
          if (st === 409 && /id compilazione già usato/.test(err.message) && tentativo === 0) {   // id in conflitto: UUID nuovo, stessi dati
            const o = leggi(); if (o.schede[k]) { o.schede[k].id = nuovoId(); salva(o); }
            continue;
          }
          const transitorio = st === undefined || st >= 500 || st === 401 || st === 429;
          r.ok = false; r.errori.push(err.message || 'errore');
          if (transitorio) { if (st === undefined || st === 401 || st === 429) return r; break; }   // rete assente: inutile insistere sulle altre schede
          const o = leggi();                                                                       // errore definitivo: conservare, non cancellare
          o.rifiutate.push({ chiave: k, entry: snap, errore: err.message, quando: new Date().toISOString() });
          salva(o); rimuoviInviati(k, snap); r.rifiutate++;
          break;
        }
      }
    }
    return r;
  }
  let fila = Promise.resolve();
  function svuota() { const p = fila.then(passata); fila = p.catch(() => {}); return p; }

  function riprovaRifiutate() {
    const o = leggi();
    for (const { chiave: k, entry } of o.rifiutate) {
      const e = o.schede[k] || (o.schede[k] = { id: entry.id, scheda_id: entry.scheda_id, squadra_id: entry.squadra_id, risposte: {} });
      for (const [v, p] of Object.entries(entry.risposte || {})) if (!e.risposte[v] || e.risposte[v].updated_at < p.updated_at) e.risposte[v] = p;
      if (entry.stato && !e.stato) e.stato = entry.stato;
    }
    o.rifiutate = []; salva(o);
  }
  const elencoRifiutate = () => leggi().rifiutate;
  return { voce, stato, pendenti, idPer, conta, svuota, riprovaRifiutate, elencoRifiutate };
}
