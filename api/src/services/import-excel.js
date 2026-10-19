// Importa un template Excel "scena" (formato GareCRI/Power Apps) nel nuovo modello.
// Serve a validare il modello sui dati reali e a migrare lo storico.
import ExcelJS from 'exceljs';
import { aggiungiSchedaDaPatologia, creaScena } from './scene.js';

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

export async function importaExcel(db, file, { eventoCodice, nomeEvento, luogo, data, titoloStampa }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const rep = { avvisi: [] };

  // 1. scale
  const scale = {};
  for (const r of tabella(wb.getWorksheet('Valutazioni'))) {
    const { rows: [s] } = await db.query(
      `insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6)
       on conflict (codice) do update set mb=excluded.mb, be=excluded.be, su=excluded.su, "in"=excluded."in", ne=excluded.ne
       returning *`,
      [r.TipoValutazione, r.MB, r.BE, r.SU, r.IN, r.NE]);
    scale[s.codice] = s;
  }

  // 2. evento + squadre
  const ctrl = wb.getWorksheet('CONTROLLO');
  const scenaCodice = String(val(ctrl.getCell('A2')));
  const titoloScena = String(val(ctrl.getCell('C2')));
  await db.query('update evento set attivo=false where attivo');          // un solo evento attivo
  const { rows: [ev] } = await db.query(
    `insert into evento (codice, nome, titolo_stampa, luogo, data, attivo) values ($1,$2,$3,$4,$5,true)
     on conflict (codice) do update set nome=excluded.nome, attivo=true returning *`,
    [eventoCodice, nomeEvento, titoloStampa, luogo, data]);
  const squadre = {};
  for (const r of tabella(wb.getWorksheet('STAMPA_SCENA'))) {
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
    const { rows: [p] } = await db.query(
      `insert into patologia (codice, nome, sigla, is_bls, is_master) values ($1,$2,$3,$4,$5)
       on conflict (codice) do update set nome = excluded.nome, sigla = excluded.sigla, is_bls = excluded.is_bls, is_master = excluded.is_master returning *`,
      [slug(tipo), tipo, m.SIGLA, m.IsBLS === 'SI', slot === 0]);
    patologie[tipo] = { ...p, slot };
    let ord = 0;
    for (const it of items.filter((i) => i.TipoScheda === tipo && i.TipoValutazione !== 'HDR')) {
      ord++;
      const scala = scale[it.TipoValutazione];
      if (!scala) { rep.avvisi.push(`scala sconosciuta ${it.TipoValutazione} (${it.ItemKey})`); continue; }
      // coerenza con i vecchi flag Has_*
      const flag = [it.Has_MB, it.Has_B, it.Has_S, it.Has_I, it.Has_NE].map(Boolean);
      const dalla = [scala.mb, scala.be, scala.su, scala.in, scala.ne].map((x) => x !== null);
      if (flag.some((f, i) => f !== dalla[i])) rep.avvisi.push(`flag Has_* diversi dalla scala: ${it.ItemKey}`);
      const { rows: [v] } = await db.query(
        `insert into voce (testo) values ($1)
         on conflict (lower(testo)) do update set testo = voce.testo returning id`, [it.TestoItem.trim()]);
      await db.query(
        `insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (patologia_id, ordine) do update set voce_id=excluded.voce_id, scala_id=excluded.scala_id, sezione=excluded.sezione, is_sep=excluded.is_sep`,
        [p.id, ord, it.Sezione, v.id, scala.id, !!it.IsSEP]);
      chiaveToOrdine[it.ItemKey] = { tipo, ordine: ord };
    }
  }

  // 4. scena composta dalla libreria (parametri dal foglio DATI)
  const scena = await creaScena(db, { eventoId: ev.id, codice: scenaCodice, titolo: titoloScena });
  const dati = tabella(wb.getWorksheet('DATI'), 5).filter((r) => r.Ruolo && r.Patologia);
  const schede = {};
  for (const d of dati) {
    const pat = patologie[d.Patologia];
    if (!pat) { rep.avvisi.push(`patologia DATI senza voci: ${d.Patologia} (${d.Ruolo}) - scheda non creata`); continue; }
    const sim = d.SimulatoreCodice === 'M' ? 'M' : String(d.SimulatoreCodice).padStart(2, '0');
    schede[pat.nome] = await aggiungiSchedaDaPatologia(db, {
      scenaId: scena.id, slot: pat.slot, patologiaId: pat.id, simulatore: sim,
      parametri: { coscienza: d.Coscienza?.toString().trim() || null, fr: d.FR, fc: d.FC, cute: d.Cute || null },
    });
  }

  // 5. risposte storiche (APP_DATA)
  let nRisposte = 0;
  const comp = {};
  for (const r of tabella(wb.getWorksheet('APP_DATA')).filter((x) => x.Valore !== null && x.ItemKey)) {
    const k = chiaveToOrdine[r.ItemKey];
    const sch = k && schede[k.tipo];
    if (!sch) { rep.avvisi.push(`risposta orfana ${r.ItemKey}`); continue; }
    const sq = squadre[r.Squadra];
    if (!sq) { rep.avvisi.push(`squadra ${r.Squadra} inesistente`); continue; }
    const ck = `${sch.id}|${sq.id}`;
    if (!comp[ck]) {
      const { rows: [c] } = await db.query(
        `insert into compilazione (scheda_id, squadra_id, stato, origine, giudice, completata_at)
         values ($1,$2,'completata','tablet_online',$3,$4) returning id`,
        [sch.id, sq.id, r.Giudice, r.Timestamp]);
      comp[ck] = c.id;
    }
    const { rows: [vv] } = await db.query(
      `select id, mb, be, su, "in", ne from scena_scheda_voce where scheda_id=$1 and ordine=$2`, [sch.id, k.ordine]);
    const cand = LIV.filter((l) => vv[l.toLowerCase()] === Number(r.Valore));
    if (cand.length !== 1) { rep.avvisi.push(`valore ${r.Valore} ambiguo/non valido per ${r.ItemKey}: ${cand}`); continue; }
    await db.query(
      `insert into risposta (compilazione_id, voce_id, livello, updated_at) values ($1,$2,$3,$4)
       on conflict do nothing`, [comp[ck], vv.id, cand[0], r.Timestamp]);
    nRisposte++;
  }
  Object.assign(rep, { eventoId: ev.id, scenaId: scena.id, voci: Object.keys(chiaveToOrdine).length,
    schede: Object.keys(schede).length, squadre: Object.keys(squadre).length, risposte: nRisposte });
  return rep;
}
