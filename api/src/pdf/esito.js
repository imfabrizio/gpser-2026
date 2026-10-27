import { fileURLToPath } from 'node:url';
// Esito di una scheda (esame, corso, allenamento): voci, livelli, punti, percentuale, soglia e firme.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { valutaEsito } from '../esito.js';

const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const ROSSO = '#C8102E';
const LIV = { MB: 'Molto bene', BE: 'Bene', SU: 'Soddisfacente', IN: 'Insufficiente', NE: 'Non eseguito' };
const LIV3 = { MB: 'Bene', SU: 'Sufficiente', NE: 'Non eseguito' };
const LIV3_MC = { MB: 'Eseguito correttamente', SU: 'Eseguito sufficientemente', NE: 'Non eseguito' };
const RUOLO_EQ = { 'team leader': 'Team Leader', autista: 'Autista', barelliere: 'Barelliere' };
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const TIPO = { esame: 'Esame', corso: 'Corso', allenamento: 'Allenamento', gara: 'Gara', olimpiadi: 'Olimpiadi', megacode: 'Mega Code' };

export function generaEsitoPdf({ evento, scheda, candidato, giudice, voci, punti, massimo, soglia, fasce, erroreGrave = false, nota = null, equipaggio = [], blocchi = [] }) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 50, left: 40, right: 40 }, info: { Title: `Esito ${scheda} – ${candidato.nome}` } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-B', FONT_B);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const L = 40, W = doc.page.width - 80;
  const ev = valutaEsito({ punti, massimo, fasce, soglia }), perc = ev.perc;
  const esito = erroreGrave ? 'NON SUPERATO' : ev.superato === null ? null : (ev.superato ? 'SUPERATO' : 'NON SUPERATO');
  const testa = () => {
    doc.rect(0, 0, doc.page.width, 70).fill(ROSSO); doc.image(LOGO, L, 10, { height: 50 });
    doc.fillColor('#fff').font('Sans-B').fontSize(14).text(`${TIPO[evento.tipo] || 'Evento'} · ${String(scheda).replace(/^(Mega Code|Esame|Corso)\s*[–-]\s*/i, '')}`, L + 64, 14, { width: W - 64, height: 18, ellipsis: true, lineBreak: false });
    doc.font('Sans').fontSize(10.5).text(`${evento.nome}${evento.luogo ? ' · ' + evento.luogo : ''}${evento.data ? ' · ' + dataIt(evento.data) : ''}`, L + 64, 38, { width: W - 64, lineBreak: false });
    doc.fillColor('#000'); return 86;
  };
  let y = testa();
  doc.font('Sans-B').fontSize(13).text(`${candidato.nome}${candidato.comitato ? ' · ' + candidato.comitato : ''}`, L, y, { width: W, lineBreak: false }); y += 20;
  doc.font('Sans').fontSize(10).fillColor('#444').text(`Valutatore: ${giudice || '—'}${nota ? '  ·  ' + nota : ''}`, L, y, { width: W, lineBreak: false }); y += 22;
  if (equipaggio.length) {                                              // Mega Code: chi compone l'equipaggio e con quale ruolo
    doc.rect(L, y, W, 16).fill('#eee'); doc.fillColor('#000').font('Sans-B').fontSize(9.5).text('Equipaggio', L + 4, y + 3, { width: W - 8, lineBreak: false }); y += 19;
    for (const m of equipaggio) {
      doc.font('Sans-B').fontSize(10).fillColor('#000').text(RUOLO_EQ[String(m.ruolo || '').toLowerCase()] || m.ruolo || '—', L + 4, y, { width: 110, lineBreak: false });
      doc.font('Sans').text(`${m.nome}${m.comitato ? ' · ' + m.comitato : ''}`, L + 120, y, { width: W - 124, lineBreak: false }); y += 15;
    }
    y += 8;
  }
  const L3 = evento.tipo === 'megacode' ? LIV3_MC : LIV3;
  let sezione = null;
  for (const v of voci) {
    const h = 15; if (y + h * 2 > doc.page.height - 150) { doc.addPage(); y = testa(); }
    if (v.sezione !== sezione) { sezione = v.sezione; doc.rect(L, y, W, 16).fill('#eee'); doc.fillColor('#000').font('Sans-B').fontSize(9.5).text(sezione || '', L + 4, y + 3, { width: W - 8, lineBreak: false }); y += 19; }
    doc.fillColor('#000').font('Sans').fontSize(9.5).text(v.testo, L + 4, y, { width: W - 215, height: 26, ellipsis: true });
    const etl = v.livello ? (v.tre ? L3 : LIV)[v.livello] : '—';
    doc.font(v.livello ? 'Sans-B' : 'Sans').fillColor(v.livello ? '#000' : '#b00').text(etl, L + W - 205, y, { width: 135, lineBreak: false })
      .text(v.livello ? `${Number(v.punti)}/${Number(v.max)}` : `0/${Number(v.max)}`, L + W - 70, y, { width: 66, align: 'right', lineBreak: false });
    y += Math.max(h, doc.heightOfString(v.testo, { width: W - 215 })) + 3;
    doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#ddd').lineWidth(0.4).stroke();
  }
  for (const b of blocchi) {                                            // skill incorporate: stesso formato, con subtotale, giudizio ed errori gravi propri
    if (y + 60 > doc.page.height - 100) { doc.addPage(); y = testa(); }
    y += 6; doc.rect(L, y, W, 18).fill(ROSSO); doc.fillColor('#fff').font('Sans-B').fontSize(10.5).text(/^skill/i.test(b.nome) ? b.nome : `Skill · ${b.nome}`, L + 4, y + 3, { width: W - 8, lineBreak: false }); y += 22;
    for (const v of b.voci) {
      if (y + 30 > doc.page.height - 100) { doc.addPage(); y = testa(); }
      doc.fillColor('#000').font('Sans').fontSize(9.5).text(v.testo, L + 4, y, { width: W - 215, height: 26, ellipsis: true });
      const etl = v.livello ? L3[v.livello] || LIV[v.livello] : '—';
      doc.font(v.livello ? 'Sans-B' : 'Sans').fillColor(v.livello ? '#000' : '#b00').text(etl, L + W - 205, y, { width: 135, lineBreak: false })
        .text(v.livello ? `${Number(v.punti)}/${Number(v.max)}` : `0/${Number(v.max)}`, L + W - 60, y, { width: 56, align: 'right', lineBreak: false });
      y += Math.max(15, doc.heightOfString(v.testo, { width: W - 215 })) + 3;
      doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#ddd').lineWidth(0.4).stroke();
    }
    doc.fillColor('#000').font('Sans-B').fontSize(10).text(`Subtotale: ${b.punti} / ${b.massimo}${b.giudizio ? '  ·  ' + b.giudizio : ''}`, L + 4, y + 2, { width: W - 8, lineBreak: false }); y += 16;
    if (b.erroriGravi?.length) { doc.font('Sans').fontSize(8.5).fillColor('#8a1c1c').text('Errori gravi: ' + b.erroriGravi.join(' · '), L + 4, y, { width: W - 8 }); y += doc.heightOfString('Errori gravi: ' + b.erroriGravi.join(' · '), { width: W - 8 }) + 4; }
    doc.fillColor('#000');
  }
  if (blocchi.length) {                                                 // riepilogo: scheda principale e ogni skill incorporata, con punti, percentuale e giudizio
    const righe = [{ nome: 'Scheda principale', p: punti, m: massimo, g: ev.giudizio }, ...blocchi.map((b) => ({ nome: b.nome, p: b.punti, m: b.massimo, g: b.giudizio }))];
    if (y + 30 + righe.length * 16 > doc.page.height - 100) { doc.addPage(); y = testa(); }
    y += 10; doc.rect(L, y, W, 16).fill('#eee'); doc.fillColor('#000').font('Sans-B').fontSize(9.5).text('Riepilogo dei punteggi', L + 4, y + 3, { width: W - 8, lineBreak: false }); y += 19;
    for (const r of righe) {
      doc.font('Sans').fontSize(9.5).fillColor('#000').text(r.nome, L + 4, y, { width: W - 250, lineBreak: false, ellipsis: true });
      doc.font('Sans-B').text(`${r.p} / ${r.m}`, L + W - 240, y, { width: 70, align: 'right', lineBreak: false }).text(r.m ? `${(r.p / r.m * 100).toFixed(0)}%` : '', L + W - 165, y, { width: 40, align: 'right', lineBreak: false });
      doc.font('Sans').text(r.g || '', L + W - 120, y, { width: 118, align: 'right', lineBreak: false });
      y += 15; doc.moveTo(L, y - 2).lineTo(L + W, y - 2).strokeColor('#ddd').lineWidth(0.4).stroke();
    }
  }
  if (y > doc.page.height - 160) { doc.addPage(); y = testa(); }
  y += 10;
  doc.rect(L, y, W, 62).lineWidth(1).strokeColor(esito === 'SUPERATO' ? '#2E7D32' : esito ? ROSSO : '#999').stroke();
  doc.fillColor('#000').font('Sans-B').fontSize(13).text(`Punteggio: ${punti} / ${massimo}  ·  ${perc.toFixed(1)}%`, L + 10, y + 10, { lineBreak: false });
  doc.font('Sans').fontSize(10).text((ev.giudizio ? `Giudizio: ${ev.giudizio}  ·  ` : '') + (erroreGrave ? 'Errore grave commesso  ·  ' : '') + (ev.sogliaPunti != null ? `Sufficienza da ${ev.sogliaPunti} punti` : soglia ? `Soglia di superamento: ${soglia}%` : 'Nessuna soglia impostata'), L + 10, y + 30, { lineBreak: false });
  if (esito) doc.font('Sans-B').fontSize(20).fillColor(esito === 'SUPERATO' ? '#2E7D32' : ROSSO).text(esito, L + W - 210, y + 18, { width: 200, align: 'right', lineBreak: false });
  y += 84;
  doc.fillColor('#000').font('Sans').fontSize(9).text('Firma dell\'istruttore / valutatore', L, y + 26, { lineBreak: false }).text('Firma del candidato', L + W / 2 + 20, y + 26, { lineBreak: false });
  doc.moveTo(L, y + 22).lineTo(L + W / 2 - 20, y + 22).strokeColor('#000').lineWidth(0.6).stroke(); doc.moveTo(L + W / 2 + 20, y + 22).lineTo(L + W, y + 22).stroke();
  doc.end(); return fine;
}
