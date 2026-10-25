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
const COL = [4, 7, 10, 13, 16];   // D G J M P
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
    voci.push({ sezione, testo: t, liv, sep: testoCella(val(ws.getCell(r, 1))) === 'SEP' });
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
