// Esito di una scheda (esame, corso, allenamento): voci, livelli, punti, percentuale, soglia e firme.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';

const FONT_R = new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url).pathname;
const FONT_B = new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url).pathname;
const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const ROSSO = '#C8102E';
const LIV = { MB: 'Molto bene', BE: 'Bene', SU: 'Soddisfacente', IN: 'Insufficiente', NE: 'Non eseguito' };
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const TIPO = { esame: 'Esame', corso: 'Corso', allenamento: 'Allenamento', gara: 'Gara', olimpiadi: 'Olimpiadi' };

export function generaEsitoPdf({ evento, scheda, candidato, giudice, voci, punti, massimo, soglia }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, info: { Title: `Esito ${scheda} – ${candidato.nome}` } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-B', FONT_B);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const L = 40, W = doc.page.width - 80, perc = massimo ? punti / massimo * 100 : 0;
  const esito = soglia ? (perc >= soglia ? 'SUPERATO' : 'NON SUPERATO') : null;
  const testa = () => {
    doc.rect(0, 0, doc.page.width, 70).fill(ROSSO); doc.image(LOGO, L, 10, { height: 50 });
    doc.fillColor('#fff').font('Sans-B').fontSize(16).text(`${TIPO[evento.tipo] || 'Evento'} · ${scheda}`, L + 64, 14, { width: W - 64, lineBreak: false });
    doc.font('Sans').fontSize(10.5).text(`${evento.nome}${evento.luogo ? ' · ' + evento.luogo : ''}${evento.data ? ' · ' + dataIt(evento.data) : ''}`, L + 64, 38, { width: W - 64, lineBreak: false });
    doc.fillColor('#000'); return 86;
  };
  let y = testa();
  doc.font('Sans-B').fontSize(13).text(`${candidato.nome}${candidato.comitato ? ' · ' + candidato.comitato : ''}`, L, y, { width: W, lineBreak: false }); y += 20;
  doc.font('Sans').fontSize(10).fillColor('#444').text(`Valutatore: ${giudice || '—'}`, L, y, { lineBreak: false }); y += 22;
  let sezione = null;
  for (const v of voci) {
    const h = 15; if (y + h * 2 > doc.page.height - 150) { doc.addPage(); y = testa(); }
    if (v.sezione !== sezione) { sezione = v.sezione; doc.rect(L, y, W, 16).fill('#eee'); doc.fillColor('#000').font('Sans-B').fontSize(9.5).text(sezione || '', L + 4, y + 3, { width: W - 8, lineBreak: false }); y += 19; }
    doc.fillColor('#000').font('Sans').fontSize(9.5).text(v.testo, L + 4, y, { width: W - 190, height: 26, ellipsis: true });
    const etl = v.livello ? LIV[v.livello] : '—';
    doc.font(v.livello ? 'Sans-B' : 'Sans').fillColor(v.livello ? '#000' : '#b00').text(etl, L + W - 180, y, { width: 100, lineBreak: false })
      .text(v.livello ? `${Number(v.punti)}/${Number(v.max)}` : `0/${Number(v.max)}`, L + W - 70, y, { width: 66, align: 'right', lineBreak: false });
    y += Math.max(h, doc.heightOfString(v.testo, { width: W - 190 })) + 3;
    doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#ddd').lineWidth(0.4).stroke();
  }
  if (y > doc.page.height - 160) { doc.addPage(); y = testa(); }
  y += 10;
  doc.rect(L, y, W, 62).lineWidth(1).strokeColor(esito === 'SUPERATO' ? '#2E7D32' : esito ? ROSSO : '#999').stroke();
  doc.fillColor('#000').font('Sans-B').fontSize(13).text(`Punteggio: ${punti} / ${massimo}  ·  ${perc.toFixed(1)}%`, L + 10, y + 10, { lineBreak: false });
  doc.font('Sans').fontSize(10).text(soglia ? `Soglia di superamento: ${soglia}%` : 'Nessuna soglia impostata', L + 10, y + 30, { lineBreak: false });
  if (esito) doc.font('Sans-B').fontSize(20).fillColor(esito === 'SUPERATO' ? '#2E7D32' : ROSSO).text(esito, L + W - 210, y + 18, { width: 200, align: 'right', lineBreak: false });
  y += 84;
  doc.fillColor('#000').font('Sans').fontSize(9).text('Firma dell\'istruttore / valutatore', L, y + 26, { lineBreak: false }).text('Firma del candidato', L + W / 2 + 20, y + 26, { lineBreak: false });
  doc.moveTo(L, y + 22).lineTo(L + W / 2 - 20, y + 22).strokeColor('#000').lineWidth(0.6).stroke(); doc.moveTo(L + W / 2 + 20, y + 22).lineTo(L + W, y + 22).stroke();
  doc.end(); return fine;
}
