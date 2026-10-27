// Scheda di valutazione di un Mega Code: equipaggio con i ruoli, checklist per fasi (anche su due pagine), totale, giudizi, errori gravi, firma del trainer.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fasceAuto } from '../esito.js';
import { righeGiudizio } from './skill.js';

const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const ROSSO = '#C62828', GRIGIO = '#E7E6E6';
const RUOLI = { 'team leader': 'Team Leader', autista: 'Autista', barelliere: 'Barelliere' };
const PUNTI = { MB: 2, SU: 1, NE: 0 };
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

export function disegnaMegacode(doc, { titolo, evento = {}, scena = {}, squadra = null, equipaggio = [], voci, fasce = null, erroriGravi = [], valutatore = '', risposte = new Map() }) {
  if (!doc.__mcFont) { doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-Bold', FONT_B); doc.__mcFont = true; }
  const n = voci.length, massimo = 2 * n, gf = fasce?.length ? fasce : fasceAuto(n);
  const L = 36, R = 595.28 - 36, W = R - L, NW = 24, cw = 52, xc = R - 3 * cw, lw = W - 3 * cw - NW;
  const testa = () => {
    doc.addPage({ size: 'A4', margin: 0 });
    doc.image(LOGO, L, 24, { height: 40 });
    doc.font('Sans-Bold').fontSize(12).fillColor('#000').text('CROCE ROSSA ITALIANA', L + 54, 28, { lineBreak: false });
    doc.font('Sans').fontSize(9).text(`${evento.nome || ''}${evento.luogo ? ' · ' + evento.luogo : ''}${evento.data_txt || evento.data ? ' · ' + dataIt(evento.data_txt || evento.data) : ''}`, L + 54, 45, { width: W - 54, lineBreak: false });
    doc.font('Sans-Bold').fontSize(10).text('MEGA CODE', R - 160, 28, { width: 160, align: 'right', lineBreak: false });
    return 74;
  };
  const intestazioneTabella = (y) => {
    doc.rect(L, y, W, 22).fillAndStroke(GRIGIO, '#000'); doc.fillColor('#000').font('Sans-Bold').fontSize(8);
    doc.text('N°', L, y + 8, { width: NW, align: 'center', lineBreak: false }); doc.text('Intervento', L + NW + 6, y + 8, { lineBreak: false });
    ['Non eseguito', 'Eseguito suff.', 'Eseguito corr.'].forEach((t, i) => { doc.rect(xc + i * cw, y, cw, 22).stroke(); doc.fontSize(6.3).text(t, xc + i * cw + 2, y + 4, { width: cw - 4, align: 'center', height: 16 }); });
    return y + 22;
  };
  let y = testa();
  doc.font('Sans-Bold').fontSize(12).fillColor('#000').text(`${scena.codice ? scena.codice + ' · ' : ''}${scena.titolo || ''}`, L, y, { width: W, lineBreak: false }); y += 17;
  doc.font('Sans').fontSize(10).text(titolo, L, y, { width: W, lineBreak: false }); y += 20;
  // equipaggio: ruolo e nome di ciascun discente
  doc.rect(L, y, W, 15).fillAndStroke(GRIGIO, '#000'); doc.fillColor('#000').font('Sans-Bold').fontSize(8.5).text(`Equipaggio${squadra?.nome ? ' · ' + squadra.nome : ''}`, L + 6, y + 4, { lineBreak: false }); y += 15;
  const righe = equipaggio.length ? equipaggio : [{ ruolo: 'team leader' }, { ruolo: 'autista' }, { ruolo: 'barelliere' }];
  for (const m of righe) {
    doc.rect(L, y, 120, 17).stroke(); doc.rect(L + 120, y, W - 120, 17).stroke();
    doc.font('Sans-Bold').fontSize(9).fillColor('#000').text(RUOLI[String(m.ruolo || '').toLowerCase()] || m.ruolo || '', L + 6, y + 4.5, { width: 110, lineBreak: false });
    doc.font('Sans').fontSize(9.5).text(m.nome ? `${m.nome}${m.comitato ? ' · ' + m.comitato : ''}` : '……………………………………………………………………', L + 126, y + 4, { width: W - 132, lineBreak: false }); y += 17;
  }
  doc.font('Sans').fontSize(9).text('Valutatore: ' + (valutatore || '……………………………………………………'), L, y + 6, { width: W, lineBreak: false }); y += 24;
  y = intestazioneTabella(y);
  let sezione = null;
  const fondo = 842 - 40;
  voci.forEach((v, i) => {
    const sezNuova = v.sezione && v.sezione !== sezione;
    doc.font('Sans').fontSize(8.5); const h = Math.max(15, doc.heightOfString(String(v.testo), { width: lw - 12 }) + 5);
    if (y + h + (sezNuova ? 14 : 0) > fondo - 6) { y = testa(); y = intestazioneTabella(y); }
    if (sezNuova) { sezione = v.sezione; doc.rect(L, y, W, 14).fillAndStroke('#222', '#000'); doc.fillColor('#fff').font('Sans-Bold').fontSize(7.5).text(String(sezione).toUpperCase(), L + 6, y + 3.5, { lineBreak: false }); y += 14; }
    doc.rect(L, y, NW, h).fillAndStroke(GRIGIO, '#000'); doc.rect(L + NW, y, lw, h).stroke();
    doc.fillColor('#000').font('Sans-Bold').fontSize(8.5).text(String(i + 1), L, y + (h - 8.5) / 2 + 1, { width: NW, align: 'center', lineBreak: false });
    doc.font('Sans').fontSize(8.5).text(String(v.testo), L + NW + 6, y + 2.5, { width: lw - 12, height: h - 2 });
    const sel = v.id != null ? risposte.get(v.id) : null;
    [['NE', 0], ['SU', 1], ['MB', 2]].forEach(([liv, k]) => {
      doc.rect(xc + k * cw, y, cw, h).stroke();
      if (sel === liv) doc.circle(xc + k * cw + cw / 2, y + h / 2, 5).fillAndStroke('#000', '#000');
      else doc.font('Sans').fontSize(9).fillColor('#777').text(String(k), xc + k * cw, y + (h - 9) / 2 + 1, { width: cw, align: 'center', lineBreak: false });
      doc.fillColor('#000');
    });
    y += h;
  });
  // totale
  const punti = voci.reduce((a, v) => a + (PUNTI[risposte.get(v.id)] ?? 0), 0), compilata = voci.some((v) => risposte.get(v.id));
  if (y + 120 > fondo) { y = testa(); }
  doc.rect(L, y, lw + NW, 22).stroke(); doc.rect(xc, y, 3 * cw, 22).stroke();
  doc.fillColor('#000').font('Sans-Bold').fontSize(9).text('Totale', L, y + 7, { width: lw + NW - 8, align: 'right', lineBreak: false });
  doc.font('Sans-Bold').text(`${compilata ? punti : '…………'} / ${massimo}`, xc, y + 7, { width: 3 * cw - 8, align: 'right', lineBreak: false }); y += 34;
  const g = righeGiudizio(gf, massimo), gw = 200;
  doc.rect(L, y, gw, 14).fillAndStroke(GRIGIO, '#000'); doc.fillColor('#000').font('Sans-Bold').fontSize(8).text('Valutazione', L + 6, y + 4, { lineBreak: false }); doc.text('Punti', L + 100, y + 4, { width: 60, align: 'center', lineBreak: false });
  g.forEach((r, i) => { const yy = y + 14 + i * 14; doc.rect(L, yy, gw, 14).stroke(); doc.font('Sans').fontSize(8.5).text(r.nome, L + 6, yy + 3.5, { lineBreak: false }); doc.text(r.punti, L + 100, yy + 3.5, { width: 60, align: 'center', lineBreak: false }); });
  const xe = L + gw + 14, we = W - gw - 14;
  doc.rect(xe, y, we, 14).fillAndStroke(GRIGIO, '#000'); doc.fillColor(ROSSO).font('Sans-Bold').fontSize(8).text('Sono errori gravi', xe + 6, y + 4, { lineBreak: false });
  doc.rect(xe, y + 14, we, 14 * g.length).stroke();
  doc.fillColor('#000').font('Sans').fontSize(8.5).text((erroriGravi.length ? erroriGravi : ['—']).map((e) => '• ' + e).join('\n'), xe + 6, y + 18, { width: we - 12, height: 14 * g.length - 6 });
  const yi = y + 14 * (g.length + 1) + 16;
  doc.fillColor('#000').font('Sans').fontSize(9).text('Trainer TSSA', L, yi, { lineBreak: false }).text('Nome Cognome ' + (valutatore || '………………………………………………'), L + 80, yi, { lineBreak: false });
  doc.text('Firma ………………………………………………', L + 80, yi + 18, { lineBreak: false }).text('Data: ……………………', R - 140, yi + 18, { lineBreak: false });
  return doc;
}
