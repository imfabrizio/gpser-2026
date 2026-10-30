// Cuore dell'inserimento: upsert a blocchi, idempotente, pronto per l'offline.
import { verificaAccessoEvento } from '../enti.js';
const RANGO = { bozza: 0, completata: 1, verificata: 2 };
const LIV = ['MB', 'BE', 'SU', 'IN', 'NE'];
const ORIGINI = ['carta', 'tablet_online', 'tablet_offline'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG = ['admin', 'organizzazione'];

/**
 * payload: { id (uuid generato dal client), scheda_id, squadra_id, origine, giudice,
 *            stato?, risposte: [{ voce_id, livello|null, updated_at? }] }
 *
 * Regole (coperte da test):
 *  - rimandare lo stesso payload N volte dà lo stesso risultato
 *  - per ogni voce vince la modifica più recente; l'orario del dispositivo non può essere nel futuro
 *    (viene limitato all'orario del server) e le scritture di organizzazione/admin vincono sempre
 *  - livello null = annulla la risposta (stessa regola di conflitto)
 *  - lo stato non retrocede: solo `riapri` può farlo
 *  - il giudice scrive solo su schede assegnate e ancora aperte: quando conferma la scheda si chiude (stato 'verificata')
 *  - scheda e squadra devono appartenere allo stesso evento, squadra attiva, evento non archiviato
 *  - ogni modifica di organizzazione/admin su una scheda già completata o verificata finisce in audit_log
 */
export async function sincronizza(db, utente, payload) {
  if (!payload || typeof payload !== 'object') throw httpErr(400, 'payload non valido');
  const { id, scheda_id, squadra_id, giudice } = payload;
  const origine = payload.origine ?? 'tablet_online';
  const risposte = payload.risposte ?? [];
  if (![id, scheda_id, squadra_id].every((x) => typeof x === 'string' && UUID.test(x))) throw httpErr(400, 'id, scheda_id e squadra_id devono essere UUID');
  if (!ORIGINI.includes(origine)) throw httpErr(400, 'origine non valida');
  if (!Array.isArray(risposte) || risposte.length > 500) throw httpErr(400, 'risposte: elenco (max 500)');
  if (payload.stato && !(payload.stato in RANGO)) throw httpErr(400, 'stato non valido');
  let isOrg = ORG.includes(utente.ruolo);
  const isMasterRuolo = utente.ruolo === 'giudice_master';

  const { rows: [ctx] } = await db.query(
    `select s.id as scheda, sc.evento_id as ev_scheda, sq.evento_id as ev_squadra, sq.attiva, e.archiviato, e.modalita, sc.id as scena_id
       from scena_scheda s join scena sc on sc.id = s.scena_id
       join squadra sq on sq.id = $2
       join evento e on e.id = sc.evento_id
      where s.id = $1`, [scheda_id, squadra_id]);
  if (!ctx) throw httpErr(404, 'scheda o squadra inesistente');
  await verificaAccessoEvento(db, utente, ctx.ev_scheda);
  if (!isOrg && await inDirezione(db, utente, ctx.ev_scheda)) isOrg = true;   // direzione gara: stessi poteri dell'organizzazione, ma solo in questa gara
  if (ctx.ev_scheda !== ctx.ev_squadra) throw httpErr(400, 'scheda e squadra appartengono a eventi diversi');
  if (!ctx.attiva) throw httpErr(409, 'squadra disattivata');
  if (ctx.archiviato) throw httpErr(409, 'evento archiviato');
  let isMasterScena = false;   // giudice master della scena a cui appartiene la scheda
  if (!isOrg) {
    isMasterScena = isMasterRuolo && (await db.query(
      `select 1 from scena_master m join scena_scheda s on s.scena_id = m.scena_id where s.id=$1 and m.utente_id=$2`, [scheda_id, utente.id])).rowCount > 0;
    const { rowCount } = await db.query('select 1 from assegnazione where scheda_id=$1 and utente_id=$2', [scheda_id, utente.id]);
    if (!rowCount && !isMasterScena) throw httpErr(403, 'scheda non assegnata a questo giudice');
    // il giudice master sulle schede degli altri giudici consulta soltanto: scrive solo sulla scheda Master o su quelle che gli sono assegnate
    if (isMasterScena && !rowCount) {
      const { rows: [sk] } = await db.query('select is_master from scena_scheda where id=$1', [scheda_id]);
      if (!sk?.is_master) throw httpErr(403, 'il giudice master consulta soltanto le schede degli altri giudici: per correggere riapri la scheda al giudice');
    }
  }
  // gara online: il giudice compila solo se il master ha aperto la scena per quella squadra
  if (ctx.modalita === 'online' && !isOrg && !isMasterScena) {
    const { rowCount } = await db.query(`select 1 from scena_turno where scena_id=$1 and squadra_id=$2 and stato='aperta'`, [ctx.scena_id, squadra_id]);
    if (!rowCount) throw httpErr(409, 'la scena non è aperta per questa squadra: attendi il giudice master');
  }
  const prioritario = isOrg || isMasterScena;   // le scritture di organizzazione e giudice master prevalgono su quelle dei giudici

  await db.query(
    `insert into compilazione (id, scheda_id, squadra_id, origine, giudice, giudice_id, iniziata_at)
     values ($1,$2,$3,$4,$5,$6, now()) on conflict do nothing`,
    [id, scheda_id, squadra_id, origine, isOrg ? (giudice ?? utente.nome) : utente.nome, utente.id]);   // il giudice non sceglie il nome stampato
  const { rows: [c] } = await db.query(
    `select * from compilazione where scheda_id=$1 and squadra_id=$2 for update`, [scheda_id, squadra_id]);
  if (!c) throw httpErr(409, 'id compilazione già usato per un\'altra scheda: genera un nuovo UUID');
  // scheda chiusa: dopo la conferma del giudice la modifica spetta solo a organizzazione, admin e giudice master della scena
  if (c.stato !== 'bozza' && !isOrg) throw httpErr(409, 'scheda chiusa: la riapre il giudice master (al giudice) oppure la direzione gara');

  let scritte = 0, scartate = 0;
  const correzioni = [];   // solo per il master: cosa ha cambiato nelle schede compilate da altri
  for (const r of risposte) {
    if (!r || typeof r !== 'object') throw httpErr(400, 'risposta non valida');
    if (!UUID.test(r.voce_id || '')) throw httpErr(400, 'voce_id non valido');
    if (r.livello !== null && !LIV.includes(r.livello)) throw httpErr(400, `livello non valido: ${r.livello}`);
    let ts = null;
    if (r.updated_at != null) { ts = new Date(r.updated_at); if (Number.isNaN(ts.getTime())) throw httpErr(400, 'updated_at non valido'); }
    const { rows: [v] } = await db.query(`select * from scena_scheda_voce where id=$1 and scheda_id=$2 for share`, [r.voce_id, scheda_id]);   // evita la race con la modifica dei punteggi
    if (!v) throw httpErr(400, `voce non appartenente alla scheda: ${r.voce_id}`);

    if (r.livello !== null && v[r.livello.toLowerCase()] === null) throw httpErr(400, `livello ${r.livello} non consentito per "${v.testo}"`);
    // Regola di conflitto per voce:
    //  - organizzazione/admin (da_org) prevale sul giudice; tra scritture della stessa categoria vince la più recente
    //  - l'orario del dispositivo non supera mai quello del server
    //  - livello null = annullo, registrato come riga (tombstone): un dato vecchio non lo fa risorgere
    const prima = isMasterScena ? (await db.query('select livello from risposta where compilazione_id=$1 and voce_id=$2', [c.id, r.voce_id])).rows[0]?.livello ?? null : null;
    const { rowCount } = await db.query(
      `insert into risposta (compilazione_id, voce_id, livello, updated_at, updated_by, da_org)
       values ($1,$2,$3::livello, least(coalesce($4::timestamptz, now()), now()), $5, $6)
       on conflict (compilazione_id, voce_id) do update
         set livello = excluded.livello, updated_at = excluded.updated_at, updated_by = excluded.updated_by, da_org = excluded.da_org
         where (excluded.da_org and not risposta.da_org)
            or (excluded.da_org = risposta.da_org and risposta.updated_at <= excluded.updated_at)`,
      [c.id, r.voce_id, r.livello, ts, utente.id, prioritario]);
    if (rowCount) { scritte++; if (isMasterScena && prima !== r.livello) correzioni.push({ voce_id: r.voce_id, prima, dopo: r.livello }); } else scartate++;
  }

  let stato = c.stato;
  if (payload.stato && RANGO[payload.stato] > RANGO[c.stato]) {
    stato = 'verificata';   // la conferma del giudice chiude subito la scheda (niente più verifica separata del master)
  }
  await db.query(
    `update compilazione set stato=$2::stato_scheda, updated_at=now(),
       completata_at = case when $2::stato_scheda <> 'bozza' and completata_at is null then now() else completata_at end,
       verificata_at = case when $2::stato_scheda = 'verificata' then now() else verificata_at end,
       verificata_da = case when $2::stato_scheda = 'verificata' then $3::uuid else verificata_da end
     where id=$1`, [c.id, stato, utente.id]);
  if (isOrg && c.stato !== 'bozza' && (scritte > 0 || stato !== c.stato)) {
    await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'modifica_scheda_chiusa','compilazione',$2,$3)`,
      [utente.id, c.id, JSON.stringify({ stato_prima: c.stato, stato_dopo: stato, voci_modificate: scritte })]);
  }
  // il giudice master può correggere le schede degli altri giudici: ogni correzione resta nel registro, voce per voce
  if (isMasterScena && c.giudice_id && c.giudice_id !== utente.id && (correzioni.length || stato !== c.stato)) {
    await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'correzione_master','compilazione',$2,$3)`,
      [utente.id, c.id, JSON.stringify({ giudice: c.giudice, stato_prima: c.stato, stato_dopo: stato, correzioni })]);
  }
  return { compilazione_id: c.id, stato, scritte, scartate };
}

// direzione gara: persone indicate per quella gara (anche se il loro ruolo di sistema è giudice o giudice master)
export async function inDirezione(db, utente, eventoId) {
  return (await db.query('select 1 from evento_direzione where evento_id=$1 and utente_id=$2', [eventoId, utente.id])).rowCount > 0;
}

export async function riapri(db, utente, compilazioneId) {
  if (!UUID.test(compilazioneId || '')) throw httpErr(400, 'id non valido');
  if (utente.ruolo === 'organizzazione') {
    const { rows: [c] } = await db.query('select sc.evento_id from compilazione c join scena_scheda s on s.id=c.scheda_id join scena sc on sc.id=s.scena_id where c.id=$1', [compilazioneId]);
    if (!c) throw httpErr(404, 'compilazione inesistente');
    await verificaAccessoEvento(db, utente, c.evento_id);
  }
  const { rows: [ev] } = await db.query('select sc.evento_id from compilazione c join scena_scheda s on s.id=c.scheda_id join scena sc on sc.id=s.scena_id where c.id=$1', [compilazioneId]);
  if (!ORG.includes(utente.ruolo) && !(ev && await inDirezione(db, utente, ev.evento_id))) {       // il giudice master può riaprire (al giudice) solo le schede della propria scena
    const ok = utente.ruolo === 'giudice_master' && (await db.query(
      `select 1 from compilazione c join scena_scheda s on s.id = c.scheda_id join scena_master m on m.scena_id = s.scena_id
        where c.id=$1 and m.utente_id=$2`, [compilazioneId, utente.id])).rowCount > 0;
    if (ok && (await db.query('select 1 from compilazione where id=$1 and giudice_id=$2', [compilazioneId, utente.id])).rowCount) throw httpErr(403, 'il giudice master non riapre le proprie schede: lo fa la direzione gara');
    if (!ok) throw httpErr(403, 'solo direzione gara, organizzazione o giudice master della scena');
  }
  const { rowCount } = await db.query(
    `update compilazione set stato='bozza', verificata_at=null, verificata_da=null, updated_at=now() where id=$1`, [compilazioneId]);
  if (!rowCount) throw httpErr(404, 'compilazione inesistente');
  await db.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1,'riapri','compilazione',$2)`, [utente.id, compilazioneId]);
}

// elimina una valutazione (risposte comprese): solo organizzazione e admin; resta nel registro
export async function elimina(db, utente, compilazioneId) {
  if (!UUID.test(compilazioneId || '')) throw httpErr(400, 'id non valido');
  if (!ORG.includes(utente.ruolo)) throw httpErr(403, 'solo organizzazione o admin');
  const { rows: [c] } = await db.query(`select c.id, c.stato, c.scheda_id, c.squadra_id, sc.evento_id, s.titolo, q.nome as squadra
      from compilazione c join scena_scheda s on s.id=c.scheda_id join scena sc on sc.id=s.scena_id join squadra q on q.id=c.squadra_id where c.id=$1 for update of c`, [compilazioneId]);
  if (!c) throw httpErr(404, 'valutazione inesistente');
  await verificaAccessoEvento(db, utente, c.evento_id);
  const { rows: [{ n }] } = await db.query('select count(*)::int n from risposta where compilazione_id=$1 and livello is not null', [c.id]);
  await db.query('delete from compilazione where id=$1', [c.id]);
  await db.query(`insert into audit_log (utente_id, azione, entita, entita_id, dettaglio) values ($1,'elimina_valutazione','compilazione',$2,$3)`,
    [utente.id, c.id, JSON.stringify({ scheda: c.titolo, squadra: c.squadra, stato: c.stato, voci: n })]);
}

export function httpErr(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}
