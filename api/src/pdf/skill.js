// Scheda "skill" nel formato cartaceo CRI: intestazione, candidato, colonne 0/1/2, subtotale, giudizi, errori gravi, istruttore.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fasceAuto } from '../esito.js';

const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const ROSSO = '#C62828', GRIGIO = '#E7E6E6';

// "Sufficiente 17-18": ogni fascia va dal suo inizio al punto prima della successiva
export function righeGiudizio(fasce, massimo) {
  const f = [...fasce].sort((a, b) => a.da - b.da);
  return f.map((x, i) => {
    const fine = i + 1 < f.length ? f[i + 1].da - 1 : massimo;
    const punti = i === 0 ? `< ${f[1] ? f[1].da : massimo}` : fine > x.da ? `${x.da}-${fine}` : `${x.da}`;
    return { nome: x.nome, punti };
  });
}

const PUNTI = { MB: 2, SU: 1, NE: 0 };
export function disegnaSkill(doc, { titolo, modello = 'SKILL', comitato = '', voci, fasce = null, erroriGravi = [], candidato = '', istruttore = '', risposte = new Map() }) {
  if (!doc.__skillFont) { doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-Bold', FONT_B); doc.__skillFont = true; }
  const n = voci.length, massimo = 2 * n;
  const gf = fasce?.length ? fasce : fasceAuto(n);
  doc.addPage({ size: 'A4', margin: 0 });
  const L = 36, R = 595.28 - 36, W = R - L;
  doc.image(LOGO, L, 30, { height: 44 });
  doc.font('Sans-Bold').fontSize(13).fillColor('#000').text('CROCE ROSSA ITALIANA', L + 60, 34, { lineBreak: false });
  doc.font('Sans').fontSize(10).text('Regionale Emilia Romagna', L + 60, 52, { lineBreak: false });
  doc.font('Sans-Bold').fontSize(10).text(`Mod: ${modello}`, R - 160, 34, { width: 160, align: 'right', lineBreak: false });
  doc.font('Sans').fontSize(9).text('COMITATO: ' + (comitato || '……………………………………'), L, 84, { width: W, lineBreak: false });
  // titolo e candidato
  doc.rect(L, 102, 215, 40).stroke();
  doc.font('Sans-Bold').fontSize(8.5).text('VALUTAZIONE TECNICA', L + 4, 106, { width: 207, align: 'center', lineBreak: false });
  doc.fontSize(8.5).text(`“${titolo}”`, L + 4, 119, { width: 207, align: 'center', height: 22 });
  doc.rect(L + 215, 102, W - 215, 40).stroke();
  doc.font('Sans').fontSize(8).text('Cognome e Nome del Candidato', L + 221, 106, { lineBreak: false });
  doc.font('Sans-Bold').fontSize(11).text(candidato || '………………………………………………………………', L + 221, 124, { width: W - 227, lineBreak: false });
  // tabella voci
  const NW = 24, cw = 60, xc = R - 3 * cw, yh = 150, hh = 30;
  doc.rect(L, yh, W, hh).fillAndStroke(GRIGIO, '#000');
  doc.fillColor('#000').font('Sans-Bold').fontSize(8.5).text('N°', L, yh + 11, { width: NW, align: 'center', lineBreak: false }); doc.moveTo(L + NW, yh).lineTo(L + NW, yh + hh).stroke(); doc.font('Sans-Bold').fontSize(8.5).text('LINEE GUIDA PER L’ESECUZIONE', L + NW + 6, yh + 11, { lineBreak: false });
  ['Non eseguito', 'Eseguito sufficientemente bene', 'Eseguito correttamente'].forEach((t, i) => {
    doc.rect(xc + i * cw, yh, cw, hh).stroke();
    doc.font('Sans-Bold').fontSize(6.3).text(t, xc + i * cw + 2, yh + 5, { width: cw - 4, align: 'center', height: hh - 6 });
  });
  const fondo = 842 - 200, disp = fondo - (yh + hh);
  const rh = Math.max(15, Math.min(26, disp / Math.max(n, 1))), fs = rh < 19 ? 8 : 9;
  let y = yh + hh, sezione = null;
  voci.forEach((v, i) => {
    if (v.sezione && v.sezione !== sezione && voci.some((x) => x.sezione !== voci[0].sezione)) {
      sezione = v.sezione;
      doc.rect(L, y, W, 13).fillAndStroke('#222', '#000'); doc.fillColor('#fff').font('Sans-Bold').fontSize(7.5).text(String(sezione).toUpperCase(), L + 6, y + 3, { lineBreak: false }); y += 13;
    }
    doc.rect(L, y, NW, rh).fillAndStroke(GRIGIO, '#000'); doc.rect(L + NW, y, W - 3 * cw - NW, rh).stroke().fillColor('#000');
    doc.font('Sans-Bold').fontSize(9).text(String(i + 1), L, y + (rh - 9) / 2 + 1, { width: NW, align: 'center', lineBreak: false });
    doc.font('Sans').fontSize(fs);
    const t = String(v.testo), h = doc.heightOfString(t, { width: W - 3 * cw - NW - 12 });
    doc.text(t, L + NW + 6, y + Math.max(1.5, (rh - h) / 2), { width: W - 3 * cw - NW - 12, height: rh - 2 });
    const sel = v.id != null ? risposte.get(v.id) : null;
    [['NE', 0], ['SU', 1], ['MB', 2]].forEach(([liv, k]) => { doc.rect(xc + k * cw, y, cw, rh).stroke();
      if (sel === liv) doc.circle(xc + k * cw + cw / 2, y + rh / 2, 5).fillAndStroke('#000', '#000');
      else doc.font('Sans').fontSize(10).fillColor('#777').text(String(k), xc + k * cw, y + (rh - 10) / 2 + 1, { width: cw, align: 'center', lineBreak: false });
      doc.fillColor('#000'); });
    y += rh;
  });
  // subtotali: una cella sotto ogni colonna (0, 1, 2); sotto, la cella del totale
  const lw = W - 3 * cw;
  doc.rect(L, y, lw, 20).stroke(); [0, 1, 2].forEach((k) => doc.rect(xc + k * cw, y, cw, 20).stroke());
  const compilata = voci.some((v) => risposte.get(v.id)), conta = (liv) => voci.filter((v) => risposte.get(v.id) === liv).length;
  if (compilata) [['NE', 0], ['SU', 1], ['MB', 2]].forEach(([liv, k]) => doc.fillColor('#000').font('Sans').fontSize(9).text(String(conta(liv) * k), xc + k * cw, y + 6, { width: cw, align: 'center', lineBreak: false }));
  doc.fillColor('#000').font('Sans-Bold').fontSize(9).text('Subtotali', L, y + 6, { width: lw - 8, align: 'right', lineBreak: false });
  y += 20;
  doc.rect(L, y, lw, 24).stroke(); doc.rect(xc, y, 3 * cw, 24).stroke();
  doc.font('Sans-Bold').fontSize(9).text('Totale', L, y + 8, { width: lw - 8, align: 'right', lineBreak: false });
  doc.font('Sans').fontSize(8).text(compilata ? `${voci.reduce((a, v) => a + (PUNTI[risposte.get(v.id)] ?? 0), 0)} su ${massimo}` : `su ${massimo}`, xc, y + 9, { width: 3 * cw - 8, align: 'right', lineBreak: false });
  y += 40;
  // giudizi
  const g = righeGiudizio(gf, massimo), gw = 200;
  doc.rect(L, y, gw, 14).fillAndStroke(GRIGIO, '#000'); doc.fillColor('#000').font('Sans-Bold').fontSize(8).text('Valutazione', L + 6, y + 4, { lineBreak: false }); doc.text('Punti', L + 90, y + 4, { width: 60, align: 'right', lineBreak: false }); doc.text('Esito', L + 156, y + 4, { width: 40, align: 'center', lineBreak: false });
  g.forEach((r, i) => { const yy = y + 14 + i * 14; doc.rect(L, yy, gw, 14).stroke(); doc.font('Sans').fontSize(8.5).text(r.nome, L + 6, yy + 3.5, { lineBreak: false }); doc.text(r.punti, L + 90, yy + 3.5, { width: 60, align: 'right', lineBreak: false }); doc.rect(L + 156, yy, gw - 156, 14).stroke(); });
  // errori gravi
  const xe = L + gw + 14, we = W - gw - 14;
  doc.rect(xe, y, we, 14).fillAndStroke(GRIGIO, '#000'); doc.fillColor(ROSSO).font('Sans-Bold').fontSize(8).text('Sono errori gravi', xe + 6, y + 4, { lineBreak: false });
  doc.rect(xe, y + 14, we, 14 * g.length).stroke();
  doc.fillColor('#000').font('Sans').fontSize(8.5).text((erroriGravi.length ? erroriGravi : ['—']).map((e) => '• ' + e).join('\n'), xe + 6, y + 18, { width: we - 12, height: 14 * g.length - 6 });
  // istruttore
  const yi = y + 14 * (g.length + 1) + 18;
  doc.fillColor('#000').font('Sans').fontSize(9);
  doc.text('Istruttore', L, yi, { lineBreak: false }); doc.text('Nome Cognome ' + (istruttore || '………………………………………………………'), L + 70, yi, { lineBreak: false });
  doc.text('Firma ………………………………………………', L + 70, yi + 20, { lineBreak: false }); doc.text('Data: ……………………', R - 140, yi + 20, { lineBreak: false });
  return doc;
}
