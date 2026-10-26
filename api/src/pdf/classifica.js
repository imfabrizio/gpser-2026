import { fileURLToPath } from 'node:url';
// Classifica in PDF: titolo della gara, tabella con i primi tre evidenziati.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';

const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const ROSSO = '#C8102E';
const PODIO = ['#F6E27A', '#DADDE2', '#E6B48A'];   // oro, argento, bronzo
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');

export function generaClassificaPdf({ evento, nomeClassifica, righe, campo, max }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 }, info: { Title: `Classifica ${nomeClassifica} – ${evento.nome}` } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-B', FONT_B);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const L = 40, W = doc.page.width - 80;
  const intesta = () => {
    doc.rect(0, 0, doc.page.width, 78).fill(ROSSO);
    doc.image(LOGO, L, 14, { height: 50 });
    doc.fillColor('#fff').font('Sans-B').fontSize(18).text(`Classifica ${nomeClassifica}`, L + 64, 18, { width: W - 64, lineBreak: false });
    doc.font('Sans').fontSize(11).text(`${evento.nome}${evento.luogo ? ' · ' + evento.luogo : ''}${evento.data ? ' · ' + dataIt(evento.data) : ''}`, L + 64, 44, { width: W - 64, lineBreak: false });
    doc.fillColor('#000'); return 98;
  };
  const col = { pos: L + 6, nome: L + 46, punti: L + W - 150, perc: L + W - 60 };
  const testa = (y) => {
    doc.font('Sans-B').fontSize(10).fillColor('#666').text('#', col.pos, y, { lineBreak: false }).text('Squadra', col.nome, y, { lineBreak: false })
      .text('Punti', col.punti, y, { width: 80, align: 'right', lineBreak: false });
    if (max) doc.text('%', col.perc, y, { width: 54, align: 'right', lineBreak: false });
    doc.moveTo(L, y + 15).lineTo(L + W, y + 15).strokeColor('#bbb').lineWidth(0.7).stroke(); return y + 20;
  };
  let y = testa(intesta());
  for (const r of righe) {
    const alto = r.posizione <= 3 ? 30 : 24;
    if (y + alto > doc.page.height - 50) { doc.addPage(); y = testa(intesta()); }
    if (r.posizione <= 3) doc.rect(L, y - 3, W, alto).fill(PODIO[r.posizione - 1]);
    const f = r.posizione <= 3 ? 'Sans-B' : 'Sans', sz = r.posizione <= 3 ? 15 : 11.5, dy = r.posizione <= 3 ? 4 : 2;
    doc.fillColor('#000').font(f).fontSize(sz);
    doc.text(String(r.posizione), col.pos, y + dy, { lineBreak: false });
    doc.text(`${r.numero ? r.numero + ' – ' : ''}${r.nome}`, col.nome, y + dy, { width: col.punti - col.nome - 8, lineBreak: false, ellipsis: true });
    doc.text(String(Number(r.valore)), col.punti, y + dy, { width: 80, align: 'right', lineBreak: false });
    if (max) doc.text((Number(r.valore) / max * 100).toFixed(1) + '%', col.perc, y + dy, { width: 54, align: 'right', lineBreak: false });
    y += alto + 2;
  }
  if (max) doc.font('Sans').fontSize(9).fillColor('#666').text(`Massimo teorico: ${max}`, L, y + 8, { lineBreak: false });
  doc.end(); return fine;
}
