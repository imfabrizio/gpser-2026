// Importa una scena dal vecchio formato "All in one" (un file per scena e per squadra):
// foglio DATI (scena, titolo, elenco schede con parametri) + un foglio "Calcolo <scheda>" per ogni scheda, con i punti
// per livello (colonne D, G, J, M, P = MB, BE, SU, IN, NE) e la marcatura SEP in colonna A.
// I fogli "Stampa ..." sono solo layout e vengono ignorati.
import ExcelJS from 'exceljs';
import { aggiungiSchedaDaPatologia, creaScena } from './scene.js';
import { httpErr } from './compilazioni.js';

const val = (c) => {
  const v = c?.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) return v.result ?? v.text ?? null;
  return v ?? null;
};
const COL = [4, 7, 10, 13, 16];   // D G J M P: punti dei livelli MB BE SU IN NE
const MARK = [5, 8, 11, 14, 17];  // E H K N Q: la «x» del giudice sul livello scelto
const LIVELLI = ['mb', 'be', 'su', 'in', 'ne'];
const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase();
const num = (v) => (typeof v === 'number' ? v : (v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null));
const testoCella = (v) => (v === null || v === undefined || v === '' ? null : String(v).trim());

export function èAllInOne(wb) {
  return !!wb.getWorksheet('DATI') && !wb.getWorksheet('CONTROLLO') && wb.worksheets.some((w) => /^Calcolo/i.test(w.name));
}

function leggiScheda(ws) {
  let sezione = null; const voci = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const t = testoCella(val(ws.getCell(r, 2)));
    if (!t) continue;
    if (t === 'Tot' || t === 'SEP') break;
    const liv = COL.map((c) => num(val(ws.getCell(r, c))));
    if (liv.every((x) => x === null)) {
      if (/^Item \d+$/.test(t)) continue;       // righe segnaposto non usate
      sezione = t; continue;
    }
    if (!sezione) sezione = 'Valutazione';
    const marks = MARK.map((c) => String(val(ws.getCell(r, c)) ?? '').trim().toLowerCase() === 'x');
    voci.push({ sezione, testo: t, liv, marks, sep: testoCella(val(ws.getCell(r, 1))) === 'SEP' });
  }
  return voci;
}

export async function importaAllInOne(db, wb, opz) {
  const { eventoId, eventoCodice, nomeEvento, luogo, data, titoloStampa, tipoEvento = 'gara', sostituisci = false, nomeSorgente = '' } = opz;
  const rep = { avvisi: [] };
  const d = wb.getWorksheet('DATI');
  const scenaCodice = String(val(d.getCell('A2')) ?? '').trim().toUpperCase();
  const titoloScena = String(val(d.getCell('C2')) ?? '').trim();
  if (!scenaCodice || !titoloScena) throw httpErr(400, 'file non riconosciuto: codice o titolo scena mancanti');
  // elenco schede di DATI (sotto l'intestazione RUOLO)
  let r0 = 0;
  for (let r = 1; r <= 25; r++) if (String(val(d.getCell(r, 1)) ?? '').trim().toUpperCase() === 'RUOLO') { r0 = r; break; }
  if (!r0) throw httpErr(400, 'file non riconosciuto: nel foglio DATI manca l\'intestazione RUOLO');
  const righe = [];
  for (let r = r0 + 1; testoCella(val(d.getCell(r, 1))); r++) {
    righe.push({ ruolo: testoCella(val(d.getCell(r, 1))), sim: val(d.getCell(r, 2)), patologia: testoCella(val(d.getCell(r, 3))),
      coscienza: testoCella(val(d.getCell(r, 4))), fr: testoCella(val(d.getCell(r, 5))), fc: testoCella(val(d.getCell(r, 6))), cute: testoCella(val(d.getCell(r, 7))),
      max: num(val(d.getCell(r, 9))) });
  }
  const fogli = wb.worksheets.filter((w) => /^Calcolo/i.test(w.name));
  if (!righe.length || righe.length !== fogli.length) throw httpErr(400, `file non coerente: ${righe.length} schede in DATI ma ${fogli.length} fogli «Calcolo»`);

  // evento
  let ev;
  if (eventoId) {
    ({ rows: [ev] } = await db.query('select * from evento where id=$1', [eventoId]));
    if (!ev) throw httpErr(404, 'evento inesistente');
  } else {
    ({ rows: [ev] } = await db.query(
      `insert into evento (codice, nome, tipo, titolo_stampa, luogo, data, attivo) values ($1,$2,$3,$4,$5,$6,false)
       on conflict (codice) do update set nome = evento.nome returning *`,
      [eventoCodice, nomeEvento, tipoEvento, titoloStampa, luogo, data]));
  }
  const { rows: [vecchia] } = await db.query('select id from scena where evento_id=$1 and codice=$2', [ev.id, scenaCodice]);
  if (vecchia && !sostituisci) throw httpErr(409, `la scena ${scenaCodice} esiste già nell'evento ${ev.codice}: non importata (spunta «Sostituisci» per rimpiazzarla)`);
  if (vecchia) {
    await db.query('delete from risposta where compilazione_id in (select c.id from compilazione c join scena_scheda s on s.id=c.scheda_id where s.scena_id=$1)', [vecchia.id]);
    await db.query('delete from compilazione where scheda_id in (select id from scena_scheda where scena_id=$1)', [vecchia.id]);
    await db.query('delete from scena where id=$1', [vecchia.id]);
  }
  const ambito = ev.tipo === 'olimpiadi' ? 'OLI' : 'GARA';
  const etichetta = `${ev.nome}`.replace(/\s+/g, ' ').trim();
  const scena = await creaScena(db, { eventoId: ev.id, codice: scenaCodice, titolo: titoloScena, ordine: scenaCodice.charCodeAt(0) });

  let nVoci = 0;
  for (const [i, riga] of righe.entries()) {
    const master = riga.ruolo.toLowerCase() === 'master';
    const voci = leggiScheda(fogli[i]);
    if (!voci.length) { rep.avvisi.push(`${fogli[i].name}: nessuna voce`); continue; }
    const max = voci.reduce((s, v) => s + (v.liv.some((x) => x !== null && x > 0) ? Math.max(...v.liv.filter((x) => x !== null)) : 0), 0);
    if (riga.max !== null && max !== riga.max) rep.avvisi.push(`${riga.patologia}: massimo calcolato ${max}, dichiarato in DATI ${riga.max}`);
    const nome = master ? 'Master' : riga.patologia;
    const codice = `${slug(nome)}_${ambito}_${slug(ev.codice)}_${scenaCodice}`.slice(0, 80);
    const sigla = (master ? 'MAS' : slug(nome).replace(/_/g, '').slice(0, 3)).padEnd(3, 'X');
    const bls = !master && /BLS|ACC|arresto/i.test(nome);
    const { rows: [p] } = await db.query(
      `insert into patologia (codice, nome, sigla, is_bls, is_master, categoria) values ($1,$2,$3,$4,$5,$6)
       on conflict (codice) do update set nome=excluded.nome, sigla=excluded.sigla, is_bls=excluded.is_bls, is_master=excluded.is_master, categoria=excluded.categoria returning *`,
      [codice, `${nome} · ${etichetta} ${scenaCodice}`, sigla, bls, master, nome]);
    await db.query('delete from patologia_voce where patologia_id=$1', [p.id]);
    let ord = 0;
    for (const v of voci) {
      const [mb, be, su, inn, ne] = v.liv;
      const cod = `${mb ?? '-'}/${be ?? '-'}/${su ?? '-'}/${inn ?? '-'}/${ne ?? '-'}`;
      let { rows: [sc] } = await db.query(
        `select id from scala_punteggio where mb is not distinct from $1 and be is not distinct from $2 and su is not distinct from $3 and "in" is not distinct from $4 and ne is not distinct from $5 order by (codice like '%/%') limit 1`,
        [mb, be, su, inn, ne]);
      if (!sc) ({ rows: [sc] } = await db.query(
        `insert into scala_punteggio (codice, mb, be, su, "in", ne) values ($1,$2,$3,$4,$5,$6) on conflict (codice) do update set codice=excluded.codice returning id`,
        [cod, mb, be, su, inn, ne]));
      const { rows: [vc] } = await db.query(`insert into voce (testo) values ($1) on conflict (lower(testo)) do update set testo = voce.testo returning id`, [v.testo]);
      ord++;
      await db.query(`insert into patologia_voce (patologia_id, ordine, sezione, voce_id, scala_id, is_sep) values ($1,$2,$3,$4,$5,$6)`, [p.id, ord, v.sezione, vc.id, sc.id, v.sep]);
    }
    nVoci += ord;
    const sim = master ? 'M' : String(riga.sim).padStart(2, '0');
    await aggiungiSchedaDaPatologia(db, { scenaId: scena.id, slot: i, patologiaId: p.id, titolo: nome, simulatore: sim,
      parametri: master ? {} : { coscienza: riga.coscienza, fr: riga.fr, fc: riga.fc, cute: riga.cute } });
  }
  Object.assign(rep, { eventoId: ev.id, eventoCodice: ev.codice, scenaCodice, scenaTitolo: titoloScena, scenaId: scena.id,
    voci: nVoci, schede: righe.length, squadre: 0, risposte: 0, formato: 'all-in-one' });
  return rep;
}

/**
 * Importa le VALUTAZIONI di un file compilato (una squadra, una scena) nella scena già presente nell'evento:
 * per ogni scheda una compilazione completata (origine «carta»), con un livello per ogni voce marcata con la «x».
 * Il totale ricalcolato dalle voci viene confrontato con il «Realizzato» scritto nel file.
 */
export async function importaValutazioniAllInOne(db, wb, { eventoId, sostituisci = false }) {
  const rep = { avvisi: [] };
  const d = wb.getWorksheet('DATI');
  const scenaCodice = String(val(d.getCell('A2')) ?? '').trim().toUpperCase();
  const nSquadra = num(val(d.getCell('B2')));
  let r0 = 0;
  for (let r = 1; r <= 25; r++) if (String(val(d.getCell(r, 1)) ?? '').trim().toUpperCase() === 'RUOLO') { r0 = r; break; }
  if (!scenaCodice || nSquadra === null || !r0) throw httpErr(400, 'file non riconosciuto: scena, squadra o elenco schede mancanti');
  const righe = [];
  for (let r = r0 + 1; testoCella(val(d.getCell(r, 1))); r++) righe.push({ patologia: testoCella(val(d.getCell(r, 3))), realizzato: num(val(d.getCell(r, 10))) });
  const fogli = wb.worksheets.filter((w) => /^Calcolo/i.test(w.name));
  if (righe.length !== fogli.length) throw httpErr(400, `file non coerente: ${righe.length} schede in DATI ma ${fogli.length} fogli «Calcolo»`);
  const { rows: [sc] } = await db.query('select id from scena where evento_id=$1 and codice=$2', [eventoId, scenaCodice]);
  if (!sc) throw httpErr(404, `la scena ${scenaCodice} non c'è nell'evento: importa prima le schede della scena`);
  const { rows: [sq] } = await db.query('select id from squadra where evento_id=$1 and numero=$2', [eventoId, nSquadra]);
  if (!sq) throw httpErr(404, `la squadra ${nSquadra} non c'è nell'evento`);
  const { rows: schede } = await db.query('select id, titolo, slot from scena_scheda where scena_id=$1 order by slot', [sc.id]);
  if (schede.length !== righe.length) throw httpErr(400, `la scena ${scenaCodice} ha ${schede.length} schede, il file ne ha ${righe.length}`);
  const { rowCount: gia } = await db.query('select 1 from compilazione where squadra_id=$1 and scheda_id = any($2::uuid[])', [sq.id, schede.map((x) => x.id)]);
  if (gia && !sostituisci) throw httpErr(409, `la squadra ${nSquadra} ha già valutazioni nella scena ${scenaCodice}: non importate (spunta «Sostituisci»)`);
  if (gia) {
    await db.query('delete from risposta where compilazione_id in (select id from compilazione where squadra_id=$1 and scheda_id = any($2::uuid[]))', [sq.id, schede.map((x) => x.id)]);
    await db.query('delete from compilazione where squadra_id=$1 and scheda_id = any($2::uuid[])', [sq.id, schede.map((x) => x.id)]);
  }
  let nRisposte = 0;
  for (const [i, riga] of righe.entries()) {
    const sch = schede[i];
    const { rows: stored } = await db.query('select id, ordine, testo, mb, be, su, "in", ne from scena_scheda_voce where scheda_id=$1 order by ordine', [sch.id]);
    const voci = leggiScheda(fogli[i]);
    const usate = new Set(); let tot = 0; let nonApp = 0; const scelte = [];
    for (const v of voci) {
      const k = norm(v.testo);
      const st = stored.find((x) => !usate.has(x.id) && norm(x.testo) === k);
      const segnate = v.marks.flatMap((m, j) => (m ? [j] : []));
      if (v.liv.every((x) => x === null || x === 0) && segnate.length) { nonApp++; continue; }   // voce azzerata in questo file (non applicabile alla squadra): nessun punto
      if (!st) { if (segnate.length) rep.avvisi.push(`${sch.titolo}: voce non trovata nella scheda della scena: «${v.testo}»`); continue; }
      usate.add(st.id);
      if (segnate.length > 1) { rep.avvisi.push(`${sch.titolo}: più livelli segnati per «${v.testo}»: voce saltata`); continue; }
      if (!segnate.length) continue;
      const j = segnate[0], punti = st[LIVELLI[j]];
      if (punti === null || punti === undefined) { rep.avvisi.push(`${sch.titolo}: il livello ${LIVELLI[j].toUpperCase()} non esiste per «${v.testo}»`); continue; }
      scelte.push([st.id, LIVELLI[j]]); tot += punti;
    }
    if (nonApp) rep.avvisi.push(`${sch.titolo}: ${nonApp} voci azzerate nel file della squadra (non applicabili): non contate`);
    if (riga.realizzato !== null && tot !== riga.realizzato) rep.avvisi.push(`${sch.titolo}: totale ricalcolato ${tot}, nel file ${riga.realizzato}`);
    if (!scelte.length) { rep.avvisi.push(`${sch.titolo}: nessuna valutazione nel file`); continue; }
    const { rows: [c] } = await db.query(
      `insert into compilazione (scheda_id, squadra_id, stato, origine, completata_at) values ($1,$2,'completata','carta', now()) returning id`, [sch.id, sq.id]);
    await db.query(
      `insert into risposta (compilazione_id, voce_id, livello) select $1, x.v, x.l::livello from unnest($2::uuid[], $3::text[]) as x(v, l)`,
      [c.id, scelte.map((x) => x[0]), scelte.map((x) => x[1].toUpperCase())]);
    nRisposte += scelte.length;
  }
  Object.assign(rep, { eventoId, scenaCodice, scenaTitolo: String(val(d.getCell('C2')) ?? ''), scenaId: sc.id, voci: 0, schede: righe.length, squadre: 1, risposte: nRisposte, formato: 'all-in-one valutazioni' });
  return rep;
}
