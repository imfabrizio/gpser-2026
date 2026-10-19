// Importa un template Excel "scena" (formato GareCRI/Power Apps) nel nuovo modello.
// Serve a migrare lo storico (gare e Olimpiadi) e a popolare la libreria di patologie.
import ExcelJS from 'exceljs';
import { aggiungiSchedaDaPatologia, creaScena } from './scene.js';
import { httpErr } from './compilazioni.js';

const val = (c) => {
  const v = c?.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) return v.result ?? v.text ?? null;
  return v ?? null;
};
const tabella = (ws, hr = 1) => {
  const rows = [];
  const head = ws.getRow(hr).values.slice(1).map((h) => (h == null ? null : String(val({ value: h })).trim()));
  ws.eachRow((row, n) => {
    if (n <= hr) return;
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = val(row.getCell(i + 1)); });
    if (Object.values(o).some((x) => x !== null && x !== '')) rows.push(o);
  });
  return rows;
};
const LIV = ['MB', 'BE', 'SU', 'IN', 'NE'];
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase();

/**
 * file: percorso oppure Buffer del .xlsx
 * opzioni: { eventoId | (eventoCodice, nomeEvento, titoloStampa, luogo, data, tipoEvento), attiva = true }
 *  - eventoId: importa nell'evento esistente; altrimenti l'evento viene creato (o riusato se il codice esiste già)
 *  - attiva: true (default, vecchio comportamento) rende attivo l'evento; false lo lascia com'è
 * Libreria: ogni scheda diventa una patologia propria "<Tipo> · Gara|Olimpiadi <scena>" (le schede con lo stesso nome
 * hanno quasi sempre voci e punteggi diversi tra scene e tra gare/Olimpiadi, quindi non si fondono).
 */
export async function importaExcel(db, file, opz) {
  const { eventoId, eventoCodice, nomeEvento, luogo, data, titoloStampa, tipoEvento = 'gara', attiva = true } = opz;
  const wb = new ExcelJS.Workbook();
  if (Buffer.isBuffer(file)) await wb.xlsx.load(file); else await wb.xlsx.readFile(file);
  const rep = { avvisi: [] };
  for (const f of ['Valutazioni', 'CONTROLLO', 'STAMPA_SCENA', 'MAP_SCENA', 'APP_ITEMS', 'DATI', 'APP_DATA']) {
    if (!wb.getWorksheet(f)) throw httpErr(400, `file non riconosciuto: manca il foglio "${f}"`);
  }

  // 1. scale
  const scale = {};
  for (const r of tabella(wb.getWorksheet('Valutazioni'))) {
    if (!r.TipoValutazione) continue;
    const { rows: [s] } = await db.query(
      `insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6)
       on conflict (codice) do update set mb=excluded.mb, be=excluded.be, su=excluded.su, "in"=excluded."in", ne=excluded.ne
       returning *`,
      [r.TipoValutazione, r.MB, r.BE, r.SU, r.IN, r.NE]);
    scale[s.codice] = s;
  }

  // 2. evento + squadre
  const ctrl = wb.getWorksheet('CONTROLLO');
  const scenaCodice = String(val(ctrl.getCell('A2')) ?? '').trim().toUpperCase();
  const titoloScena = String(val(ctrl.getCell('C2')) ?? '').trim();
  if (!scenaCodice || !titoloScena) throw httpErr(400, 'file non riconosciuto: codice o titolo scena mancanti');
  let ev;
  if (eventoId) {
    ({ rows: [ev] } = await db.query('select * from evento where id=$1 and not archiviato', [eventoId]));
    if (!ev) throw httpErr(404, 'evento inesistente o archiviato');
  } else {
    if (attiva) await db.query('update evento set attivo=false where attivo');          // un solo evento attivo
    ({ rows: [ev] } = await db.query(
      `insert into evento (codice, nome, tipo, titolo_stampa, luogo, data, attivo) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (codice) do update set nome = case when $7 then excluded.nome else evento.nome end, attivo = evento.attivo or $7 returning *`,
      [eventoCodice, nomeEvento, tipoEvento, titoloStampa, luogo, data, attiva]));
  }
  const { rowCount: esiste } = await db.query('select 1 from scena where evento_id=$1 and codice=$2', [ev.id, scenaCodice]);
  if (esiste) throw httpErr(409, `la scena ${scenaCodice} esiste già nell'evento ${ev.codice}: non importata`);
  const ambito = ev.tipo === 'olimpiadi' ? { codice: 'OLI', nome: 'Olimpiadi' } : { codice: 'GARA', nome: 'Gara' };
  const squadre = {};
  for (const r of tabella(wb.getWorksheet('STAMPA_SCENA'))) {
    if (r.SquadraID === null || r.SquadraID === undefined) continue;
    const { rows: [s] } = await db.query(
      `insert into squadra (evento_id, numero, nome, attiva) values ($1,$2,$3,$4)
       on conflict (evento_id, numero) do update set nome = excluded.nome returning *`,
      [ev.id, r.SquadraID, r.Squadra_Nome, r.SquadraID !== 0]);
    squadre[r.SquadraID] = s;
  }

  // 3. libreria: voci + patologie
  const mappa = tabella(wb.getWorksheet('MAP_SCENA'));            // slot, tipo, sigla, IsBLS
  const items = tabella(wb.getWorksheet('APP_ITEMS')).sort((a, b) => a.Ordine - b.Ordine);
  const patologie = {};   // TipoScheda -> {row, slot}
  const chiaveToOrdine = {}; // ItemKey -> {tipo, ordine}
  for (const m of mappa) {
    const tipo = m['B (TipoScheda)'];
    const slot = m['A(SlotScheda)'];
    if (!tipo) continue;
    const { rows: [p] } = await db.query(
      `insert into patologia (codice, nome, sigla, is_bls, is_master) values ($1,$2,$3,$4,$5)
       on conflict (codice) do update set nome = excluded.nome, sigla = excluded.sigla, is_bls = excluded.is_bls, is_master = excluded.is_master returning *`,
      [`${slug(tipo)}_${ambito.codice}_${scenaCodice}`, `${tipo.replace(/_/g, ' ')} · ${ambito.nome} ${scenaCodice}`, m.SIGLA, m.IsBLS === 'SI', slot === 0]);
    patologie[tipo] = { ...p, slot, titolo: tipo.replace(/_/g, ' ') };
    await db.query('delete from patologia_voce where patologia_id=$1', [p.id]);   // reimportazione: la patologia riflette il file
    let ord = 0;
    for (const it of items.filter((i) => i.TipoScheda === tipo && i.TipoValutazione !== 'HDR')) {
      const scala = scale[it.TipoValutazione];
      if (!scala) { rep.avvisi.push(`scala sconosciuta ${it.TipoValutazione} (${it.ItemKey})`); continue; }
      ord++;
      // coerenza con i vecchi flag Has_*
      const flag = [it.Has_MB, it.Has_B, it.Has_S, it.Has_I, it.Has_NE].map(Boolean);
      const dalla = [scala.mb, scala.be, scala.su, scala.in, scala.ne].map((x) => x !== null);
      if (flag.some((f, i) => f !== dalla[i])) rep.avvisi.push(`flag Has_* diversi dalla scala: ${it.ItemKey}`);
      const { rows: [v] } = await db.query(
        `insert into voce (testo) values ($1)
         on conflict (lower(testo)) do update set testo = voce.testo returning id`, [String(it.TestoItem).trim()]);
      await db.query(
        `insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep)
         values ($1,$2,$3,$4,$5,$6)`,
        [p.id, ord, it.Sezione, v.id, scala.id, !!it.IsSEP]);
      chiaveToOrdine[it.ItemKey] = { tipo, ordine: ord };
    }
  }

  // 4. scena composta dalla libreria (parametri dal foglio DATI)
  const scena = await creaScena(db, { eventoId: ev.id, codice: scenaCodice, titolo: titoloScena });
  const dati = tabella(wb.getWorksheet('DATI'), 5).filter((r) => r.Ruolo && r.Patologia);
  // nome della patologia in DATI -> nome in MAP_SCENA: uguale, poi senza maiuscole/simboli (ICTUS = Ictus), poi prefisso univoco (BLSD = BLS)
  const nomiMappa = Object.keys(patologie);
  const risolvi = (nome) => {
    if (patologie[nome]) return nome;
    const n = norm(nome);
    const uguali = nomiMappa.filter((k) => norm(k) === n);
    if (uguali.length === 1) return uguali[0];
    const prefisso = nomiMappa.filter((k) => n.startsWith(norm(k)) || norm(k).startsWith(n));
    return prefisso.length === 1 ? prefisso[0] : null;
  };
  const schede = {};
  for (const d of dati) {
    const chiave = risolvi(String(d.Patologia));
    const pat = chiave && patologie[chiave];
    if (!pat) { rep.avvisi.push(`DATI: "${d.Patologia}" (${d.Ruolo}) non ha voci in questo file - scheda non creata`); continue; }
    if (chiave !== d.Patologia) rep.avvisi.push(`DATI: "${d.Patologia}" abbinata a "${chiave}"`);
    if (schede[chiave]) { rep.avvisi.push(`DATI: "${d.Patologia}" compare due volte - ignorata la seconda`); continue; }
    const sim = d.SimulatoreCodice === 'M' ? 'M' : String(d.SimulatoreCodice).padStart(2, '0');
    schede[chiave] = await aggiungiSchedaDaPatologia(db, {
      scenaId: scena.id, slot: pat.slot, patologiaId: pat.id, titolo: pat.titolo, simulatore: sim,
      parametri: { coscienza: d.Coscienza?.toString().trim() || null, fr: d.FR, fc: d.FC, cute: d.Cute || null },
    });
  }

  // 5. risposte storiche (APP_DATA): una compilazione per scheda×squadra, risposte inserite a blocchi
  const vociScheda = {};   // scheda.id -> Map(ordine -> voce)
  for (const s of Object.values(schede)) {
    const { rows } = await db.query(`select id, ordine, mb, be, su, "in", ne from scena_scheda_voce where scheda_id=$1`, [s.id]);
    vociScheda[s.id] = new Map(rows.map((r) => [r.ordine, r]));
  }
  const comp = {};      // "scheda|squadra" -> { id, righe: Map(voce_id -> [livello, timestamp]) }
  for (const r of tabella(wb.getWorksheet('APP_DATA')).filter((x) => x.Valore !== null && x.ItemKey)) {
    const k = chiaveToOrdine[r.ItemKey];
    const sch = k && schede[k.tipo];
    if (!sch) { rep.avvisi.push(`risposta orfana ${r.ItemKey}`); continue; }
    const sq = squadre[r.Squadra];
    if (!sq) { rep.avvisi.push(`squadra ${r.Squadra} inesistente`); continue; }
    const vv = vociScheda[sch.id].get(k.ordine);
    const cand = vv ? LIV.filter((l) => vv[l.toLowerCase()] === Number(r.Valore)) : [];
    if (cand.length !== 1) { rep.avvisi.push(`valore ${r.Valore} ambiguo/non valido per ${r.ItemKey}: ${cand}`); continue; }
    const ck = `${sch.id}|${sq.id}`;
    if (!comp[ck]) {
      const { rows: [c] } = await db.query(
        `insert into compilazione (scheda_id, squadra_id, stato, origine, giudice, completata_at)
         values ($1,$2,'completata','tablet_online',$3,$4) returning id`,
        [sch.id, sq.id, r.Giudice, r.Timestamp instanceof Date ? r.Timestamp : null]);
      comp[ck] = { id: c.id, righe: new Map() };
    }
    comp[ck].righe.set(vv.id, [cand[0], r.Timestamp instanceof Date ? r.Timestamp.toISOString() : null]);
  }
  let nRisposte = 0;
  for (const c of Object.values(comp)) {
    const ids = [...c.righe.keys()];
    await db.query(
      `insert into risposta (compilazione_id, voce_id, livello, updated_at)
       select $1, x.v, x.l::livello, coalesce(x.t::timestamptz, now()) from unnest($2::uuid[], $3::text[], $4::text[]) as x(v, l, t)
       on conflict do nothing`,
      [c.id, ids, ids.map((i) => c.righe.get(i)[0]), ids.map((i) => c.righe.get(i)[1])]);
    nRisposte += ids.length;
  }
  Object.assign(rep, { eventoId: ev.id, eventoCodice: ev.codice, scenaCodice, scenaTitolo: titoloScena, scenaId: scena.id,
    voci: Object.keys(chiaveToOrdine).length, schede: Object.keys(schede).length, squadre: Object.keys(squadre).length, risposte: nRisposte });
  return rep;
}
