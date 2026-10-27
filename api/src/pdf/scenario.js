import { fileURLToPath } from 'node:url';
// Descrizione di uno scenario di Mega Code in PDF: dispatch, scena, racconto, quick look, ABCDE, SAMPLE/OPQRST, evoluzione, trucchi, comportamenti, presidi.
import PDFDocument from 'pdfkit';

const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const ROSSO = '#D8232A', INK = '#1E2430', GRIGIO = '#667085', LINEA = '#D9DEE5', FONDO = '#F5F6F8';
const W = 595.28, M = 42, LARG = W - 2 * M, FONDO_PAG = 790;

export function creaScenario(can) {
  const d = can.dati || {};
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: false, info: { Title: `Scenario ${can.codice} – ${can.titolo}`, Producer: 'GPSER-2026' } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-Bold', FONT_B);
  let y = 0;
  const h = (txt, w, size, bold) => { doc.font(bold ? 'Sans-Bold' : 'Sans').fontSize(size); return doc.heightOfString(String(txt), { width: w, lineGap: 2 }); };
  const scrivi = (txt, x, yy, w, { size = 10, bold = false, color = INK } = {}) => { doc.font(bold ? 'Sans-Bold' : 'Sans').fontSize(size).fillColor(color).text(String(txt), x, yy, { width: w, lineGap: 2 }); return h(txt, w, size, bold); };
  const serve = (alt) => { if (y + alt > FONDO_PAG) { doc.addPage(); y = M; } };
  const sezione = (titolo) => { serve(46); y += 8; doc.rect(M, y + 1, 5, 14).fill(ROSSO); scrivi(titolo, M + 14, y, LARG - 14, { size: 12.5, bold: true }); y += 17; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.6).strokeColor(LINEA).stroke(); y += 8; };
  const paragrafo = (txt) => { if (!txt) return; const alt = h(txt, LARG, 10, false); serve(Math.min(alt, 60)); y += scrivi(txt, M, y, LARG) + 6; };
  const elenco = (l) => { for (const x of l || []) { const alt = h(x, LARG - 14, 10, false); serve(alt + 4); doc.circle(M + 4, y + 6, 1.6).fill(ROSSO); y += scrivi(x, M + 14, y, LARG - 14) + 3; } y += 3; };
  const coppie = (rows) => { for (const [k, v] of rows) { if (!v) continue; const alt = Math.max(h(v, LARG - 70, 10, false), 14); serve(alt + 4); scrivi(k, M, y, 60, { bold: true, color: ROSSO }); y += scrivi(v, M + 70, y, LARG - 70) + 5; } };

  doc.addPage();
  doc.rect(0, 0, W, 96).fill(ROSSO); doc.rect(0, 96, W, 4).fill('#A81A20');
  doc.roundedRect(M, 22, 56, 56, 9).fill('#FFFFFF'); doc.font('Sans-Bold').fontSize(can.codice.length > 2 ? 24 : 32).fillColor(ROSSO).text(can.codice, M, can.codice.length > 2 ? 40 : 34, { width: 56, align: 'center', lineBreak: false });
  scrivi('MEGA CODE · DESCRIZIONE DELLO SCENARIO', M + 72, 24, LARG - 72, { size: 8.5, bold: true, color: '#FFD9DB' });
  scrivi(can.titolo, M + 72, 38, LARG - 72, { size: 22, bold: true, color: '#FFFFFF' });
  y = 114;
  const chip = [can.gara_codice && ['Evento', can.gara_codice], can.tempo_min && ['Tempo', `${can.tempo_min} minuti`]].filter(Boolean);
  let x = M; for (const [e, v] of chip) { doc.font('Sans').fontSize(8); const we = doc.widthOfString(e); doc.font('Sans-Bold').fontSize(10); const wv = doc.widthOfString(String(v)); doc.roundedRect(x, y, we + wv + 24, 20, 10).fill(FONDO); scrivi(e, x + 10, y + 6.5, we + 2, { size: 8, color: GRIGIO }); scrivi(v, x + 14 + we, y + 5.5, wv + 2, { size: 10, bold: true }); x += we + wv + 32; }
  if (chip.length) y += 28;

  if (d.dispatch) { sezione('Dispatch'); paragrafo(d.dispatch); }
  if (d.scena) { sezione('Scena'); paragrafo(d.scena); }
  if (d.racconto) { sezione('Racconto del paziente'); paragrafo(d.racconto); }
  if (d.quick_look?.length) { sezione('Quick look'); elenco(d.quick_look); }
  const ab = d.abcde || {}; if (Object.values(ab).some(Boolean)) { sezione('Valutazione primaria'); coppie([['A · Vie aeree', ab.A], ['B · Respiro', ab.B], ['C · Circolo', ab.C], ['D · Neurologico', ab.D], ['E · Esposizione', ab.E]]); }
  const sa = d.sample || {}; if (Object.values(sa).some(Boolean) || d.opqrst) { sezione('Valutazione secondaria'); coppie([['S · Sintomi', sa.S], ['A · Allergie', sa.A], ['M · Medicinali', sa.M], ['P · Patologie', sa.P], ['L · Ultimo pasto', sa.L], ['E · Eventi', sa.E], ['OPQRST', d.opqrst]]); }
  if (d.evoluzione) { sezione('Evoluzione'); paragrafo(d.evoluzione); }
  if (d.destinazione) { sezione('Destinazione'); paragrafo(d.destinazione); }
  if (d.trucchi?.length) { sezione('Trucchi del simulatore'); elenco(d.trucchi); }
  if (d.comportamenti?.length) { sezione('Comportamenti del simulatore'); elenco(d.comportamenti); }
  if (d.presidi?.length) { sezione('Presidi'); elenco(d.presidi); }
  if (d.note) { sezione('Note'); paragrafo(d.note); }
  return doc;
}
