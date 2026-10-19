// Cuore dell'inserimento: upsert a blocchi, idempotente, pronto per l'offline.
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
 *  - il giudice scrive solo su schede assegnate e su schede non verificate
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
  const isOrg = ORG.includes(utente.ruolo);

  const { rows: [ctx] } = await db.query(
    `select s.id as scheda, sc.evento_id as ev_scheda, sq.evento_id as ev_squadra, sq.attiva, e.archiviato
       from scena_scheda s join scena sc on sc.id = s.scena_id
       join squadra sq on sq.id = $2
       join evento e on e.id = sc.evento_id
      where s.id = $1`, [scheda_id, squadra_id]);
  if (!ctx) throw httpErr(404, 'scheda o squadra inesistente');
  if (ctx.ev_scheda !== ctx.ev_squadra) throw httpErr(400, 'scheda e squadra appartengono a eventi diversi');
  if (!ctx.attiva) throw httpErr(409, 'squadra disattivata');
  if (ctx.archiviato) throw httpErr(409, 'evento archiviato');
  if (!isOrg) {
    const { rowCount } = await db.query('select 1 from assegnazione where scheda_id=$1 and utente_id=$2', [scheda_id, utente.id]);
    if (!rowCount) throw httpErr(403, 'scheda non assegnata a questo giudice');
  }

  await db.query(
    `insert into compilazione (id, scheda_id, squadra_id, origine, giudice, giudice_id, iniziata_at)
     values ($1,$2,$3,$4,$5,$6, now()) on conflict do nothing`,
    [id, scheda_id, squadra_id, origine, isOrg ? (giudice ?? utente.nome) : utente.nome, utente.id]);   // il giudice non sceglie il nome stampato
  const { rows: [c] } = await db.query(
    `select * from compilazione where scheda_id=$1 and squadra_id=$2 for update`, [scheda_id, squadra_id]);
  if (!c) throw httpErr(409, 'id compilazione già usato per un\'altra scheda: genera un nuovo UUID');
  if (c.stato === 'verificata' && !isOrg) throw httpErr(409, 'scheda verificata: modifica non consentita');

  let scritte = 0, scartate = 0;
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
    const { rowCount } = await db.query(
      `insert into risposta (compilazione_id, voce_id, livello, updated_at, updated_by, da_org)
       values ($1,$2,$3::livello, least(coalesce($4::timestamptz, now()), now()), $5, $6)
       on conflict (compilazione_id, voce_id) do update
         set livello = excluded.livello, updated_at = excluded.updated_at, updated_by = excluded.updated_by, da_org = excluded.da_org
         where (excluded.da_org and not risposta.da_org)
            or (excluded.da_org = risposta.da_org and risposta.updated_at <= excluded.updated_at)`,
      [c.id, r.voce_id, r.livello, ts, utente.id, isOrg]);
    rowCount ? scritte++ : scartate++;
  }

  let stato = c.stato;
  if (payload.stato && RANGO[payload.stato] > RANGO[c.stato]) {
    if (payload.stato === 'verificata' && !isOrg) throw httpErr(403, 'solo l\'organizzazione verifica');
    stato = payload.stato;
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
  return { compilazione_id: c.id, stato, scritte, scartate };
}

export async function riapri(db, utente, compilazioneId) {
  if (!ORG.includes(utente.ruolo)) throw httpErr(403, 'solo organizzazione/admin');
  if (!UUID.test(compilazioneId || '')) throw httpErr(400, 'id non valido');
  const { rowCount } = await db.query(
    `update compilazione set stato='bozza', verificata_at=null, verificata_da=null, updated_at=now() where id=$1`, [compilazioneId]);
  if (!rowCount) throw httpErr(404, 'compilazione inesistente');
  await db.query(`insert into audit_log (utente_id, azione, entita, entita_id) values ($1,'riapri','compilazione',$2)`, [utente.id, compilazioneId]);
}

export function httpErr(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}
