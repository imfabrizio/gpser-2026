import { fileURLToPath } from 'node:url';
// Riepilogo di una sessione d'esame: per ogni prova l'elenco dei candidati con esito.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';

const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const ROSSO = '#C8102E';
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

export function generaRiepilogoEsamiPdf({ sessione, prove }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, info: { Title: `Riepilogo ${sessione.nome}` } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-B', FONT_B);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const L = 40, W = doc.page.width - 80;
  const testa = () => {
    doc.rect(0, 0, doc.page.width, 70).fill(ROSSO); doc.image(LOGO, L, 10, { height: 50 });
    doc.fillColor('#fff').font('Sans-B').fontSize(16).text(`Esami · ${sessione.nome}`, L + 64, 14, { width: W - 64, lineBreak: false });
    doc.font('Sans').fontSize(10.5).text(`${sessione.luogo || ''}${sessione.data ? ' · ' + dataIt(sessione.data) : ''}`, L + 64, 38, { width: W - 64, lineBreak: false });
    doc.fillColor('#000'); return 88;
  };
  let y = testa();
  let sup = 0, tot = 0;
  for (const p of prove) for (const c of p.candidati) { tot++; if (c.esito.superato) sup++; }
  doc.font('Sans-B').fontSize(12).text(`Candidati: ${tot}   ·   Superato: ${sup}   ·   Non superato: ${tot - sup}`, L, y, { lineBreak: false }); y += 26;
  for (const p of prove) {
    if (y > doc.page.height - 130) { doc.addPage(); y = testa(); }
    doc.rect(L, y, W, 18).fill('#eee'); doc.fillColor('#000').font('Sans-B').fontSize(10.5).text(`${p.titolo}${p.valutatore ? '  ·  valutatore ' + p.valutatore : ''}`, L + 4, y + 4, { width: W - 8, lineBreak: false }); y += 22;
    for (const c of p.candidati) {
      if (y > doc.page.height - 60) { doc.addPage(); y = testa(); }
      doc.font('Sans').fontSize(10).fillColor('#000').text(`${c.nome}${c.comitato ? ' (' + c.comitato + ')' : ''}${c.ruolo === 'principale' ? ' · principale' : ''}`, L + 4, y, { width: W - 250, lineBreak: false });
      doc.text(`${c.esito.punti}/${c.esito.massimo}${c.esito.giudizio ? ' · ' + c.esito.giudizio : ''}`, L + W - 240, y, { width: 130, lineBreak: false });
      doc.font('Sans-B').fillColor(c.esito.superato ? '#2E7D32' : ROSSO).text(c.esito.superato ? 'SUPERATO' : 'NON SUPERATO', L + W - 110, y, { width: 106, align: 'right', lineBreak: false });
      y += 16; doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#ddd').lineWidth(0.4).stroke();
    }
    y += 8;
  }
  doc.end(); return fine;
}
