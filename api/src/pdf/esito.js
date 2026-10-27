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
const COL = { MB: '#2E7D32', BE: '#5E9B3C', SU: '#B8860B', IN: '#D9701A', NE: '#C8102E' };
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const TIPO = { esame: 'Esame', corso: 'Corso', allenamento: 'Allenamento', gara: 'Gara', olimpiadi: 'Olimpiadi', megacode: 'Mega Code' };

export function generaEsitoPdf({ evento, scheda, candidato, giudice, voci, punti, massimo, soglia, fasce, erroreGrave = false, nota = null, equipaggio = [], blocchi = [] }) {
  const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 40, bottom: 50, left: 40, right: 40 }, info: { Title: `Esito ${scheda} – ${candidato.nome}` } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-B', FONT_B);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const L = 40, W = doc.page.width - 80, FONDO = doc.page.height - 60;
  const ev = valutaEsito({ punti, massimo, fasce, soglia }), perc = ev.perc;
  const esito = erroreGrave ? 'NON SUPERATO' : ev.superato === null ? null : (ev.superato ? 'SUPERATO' : 'NON SUPERATO');
  const verde = '#2E7D32', coloreEsito = esito === 'SUPERATO' ? verde : esito ? ROSSO : '#777';
  const titolo = String(scheda).replace(/^(Mega Code|Esame|Corso)\s*[–-]\s*/i, '');
  const testa = () => {
    doc.rect(0, 0, doc.page.width, 70).fill(ROSSO); doc.image(LOGO, L, 10, { height: 50 });
    doc.fillColor('#fff').font('Sans-B').fontSize(14).text(`${TIPO[evento.tipo] || 'Evento'} · ${titolo}`, L + 64, 14, { width: W - 64, height: 18, ellipsis: true, lineBreak: false });
    doc.font('Sans').fontSize(10.5).text(`${evento.nome}${evento.luogo ? ' · ' + evento.luogo : ''}${evento.data ? ' · ' + dataIt(evento.data) : ''}`, L + 64, 38, { width: W - 64, lineBreak: false });
    doc.fillColor('#000'); return 88;
  };
  const nuova = () => { doc.addPage(); return testa(); };
  const banda = (y, testo, colore = '#EEF0F3', ink = '#222') => { doc.roundedRect(L, y, W, 18, 3).fill(colore); doc.fillColor(ink).font('Sans-B').fontSize(10).text(testo, L + 8, y + 4.5, { width: W - 16, lineBreak: false, ellipsis: true }); doc.fillColor('#000'); return y + 24; };
  const barra = (x, y, w, h, frac, col) => { doc.roundedRect(x, y, w, h, h / 2).fill('#E4E6EA'); if (frac > 0) doc.roundedRect(x, y, Math.max(h, w * Math.min(1, frac)), h, h / 2).fill(col); };
  const colPerc = (p) => (p >= 85 ? '#2E7D32' : p >= 75 ? '#5E9B3C' : p >= 60 ? '#D9701A' : ROSSO);
  const pill = (x, y, testo, col, w = 118) => {
    doc.roundedRect(x, y - 1, w, 14, 7).fill(col); doc.fillColor('#fff').font('Sans-B').fontSize(8.5).text(testo, x, y + 2.2, { width: w, align: 'center', lineBreak: false });
    doc.fillColor('#000');
  };
  const L3 = evento.tipo === 'megacode' ? LIV3_MC : LIV3;
  const riga = (v, y, i, bloccoSkill) => {
    const wt = W - 214, h = Math.max(16, Math.min(28, doc.font('Sans').fontSize(9.5).heightOfString(v.testo, { width: wt })) + 4);
    if (y + h > FONDO) y = nuova();
    if (i % 2) doc.rect(L, y - 2, W, h + 1).fill('#F7F8FA');
    doc.fillColor('#000').font('Sans').fontSize(9.5).text(v.testo, L + 6, y + 1, { width: wt, height: 26, ellipsis: true });
    const tre = bloccoSkill ? true : v.tre, et = v.livello ? ((tre ? L3[v.livello] : LIV[v.livello]) || LIV[v.livello]) : 'Non compilata';
    pill(L + W - 204, y + 1, et, v.livello ? COL[v.livello] : '#9AA0A8');
    doc.fillColor('#000').font('Sans-B').fontSize(9.5).text(`${v.livello ? Number(v.punti) : 0}/${Number(v.max)}`, L + W - 60, y + 1, { width: 54, align: 'right', lineBreak: false });
    return y + h;
  };

  let y = testa();
  // ── intestazione dell'esito: chi, quanto, con che giudizio ──
  doc.font('Sans-B').fontSize(15).fillColor('#111').text(candidato.nome, L, y, { width: W - 190, lineBreak: false, ellipsis: true });
  doc.font('Sans').fontSize(9.5).fillColor('#555').text(`${candidato.comitato ? candidato.comitato + '  ·  ' : ''}Valutatore: ${giudice || '—'}${nota ? '  ·  ' + nota : ''}`, L, y + 20, { width: W - 190, lineBreak: false, ellipsis: true });
  if (esito) { doc.roundedRect(L + W - 170, y - 2, 170, 34, 6).fill(coloreEsito); doc.fillColor('#fff').font('Sans-B').fontSize(16).text(esito, L + W - 170, y + 8, { width: 170, align: 'center', lineBreak: false }); }
  y += 44;
  doc.roundedRect(L, y, W, 78, 8).lineWidth(1).strokeColor('#D5D8DE').stroke();
  doc.fillColor(colPerc(perc)).font('Sans-B').fontSize(34).text(`${perc.toFixed(0)}%`, L + 16, y + 10, { width: 110, lineBreak: false });
  doc.fillColor('#111').font('Sans-B').fontSize(12).text(`${punti} / ${massimo} punti`, L + 130, y + 12, { lineBreak: false });
  doc.font('Sans').fontSize(10).fillColor('#444').text((ev.giudizio ? `Giudizio: ${ev.giudizio}` : '') + (erroreGrave ? '  ·  Errore grave commesso' : ''), L + 130, y + 30, { width: W - 150, lineBreak: false });
  const bx = L + 130, bw = W - 150; barra(bx, y + 52, bw, 9, massimo ? punti / massimo : 0, colPerc(perc));
  const marcatore = ev.sogliaPunti != null && massimo ? ev.sogliaPunti / massimo : soglia ? soglia / 100 : null;
  if (marcatore != null) { const mx = bx + bw * marcatore; doc.moveTo(mx, y + 48).lineTo(mx, y + 65).lineWidth(1.4).strokeColor('#222').stroke(); doc.fillColor('#555').font('Sans').fontSize(8).text(ev.sogliaPunti != null ? `sufficienza da ${ev.sogliaPunti} punti` : `soglia ${soglia}%`, Math.min(mx - 50, bx + bw - 100), y + 66, { width: 100, align: 'center', lineBreak: false }); }
  doc.fillColor('#000'); y += 96;

  if (equipaggio.length) {                                              // Mega Code: chi compone l'equipaggio e con quale ruolo
    y = banda(y, 'Equipaggio');
    equipaggio.forEach((m, i) => {
      if (y + 16 > FONDO) y = nuova();
      doc.font('Sans-B').fontSize(9.5).fillColor('#C8102E').text(RUOLO_EQ[String(m.ruolo || '').toLowerCase()] || m.ruolo || '—', L + 8, y, { width: 110, lineBreak: false });
      doc.font('Sans').fillColor('#000').text(`${m.nome}${m.comitato ? ' · ' + m.comitato : ''}`, L + 124, y, { width: W - 132, lineBreak: false, ellipsis: true }); y += 15;
    });
    y += 8;
  }
  if (blocchi.length) {                                                 // riepilogo con barre: scheda principale e ogni skill incorporata
    const righe = [{ nome: 'Scheda principale', p: punti, m: massimo, g: ev.giudizio }, ...blocchi.map((b) => ({ nome: b.nome, p: b.punti, m: b.massimo, g: b.giudizio }))];
    if (y + 30 + righe.length * 18 > FONDO) y = nuova();
    y = banda(y, 'Riepilogo dei punteggi');
    for (const r of righe) {
      const pc = r.m ? r.p / r.m * 100 : 0;
      doc.font('Sans').fontSize(9.5).fillColor('#000').text(r.nome, L + 8, y, { width: 190, lineBreak: false, ellipsis: true });
      barra(L + 206, y + 2, 140, 8, pc / 100, colPerc(pc));
      doc.font('Sans-B').text(`${r.p}/${r.m}`, L + 354, y, { width: 50, align: 'right', lineBreak: false }).text(`${pc.toFixed(0)}%`, L + 406, y, { width: 36, align: 'right', lineBreak: false });
      doc.font('Sans').fillColor('#444').text(r.g || '', L + 448, y, { width: W - 450, align: 'right', lineBreak: false, ellipsis: true });
      y += 17;
    }
    y += 8;
  }

  // ── dettaglio voce per voce ──
  if (y + 60 > FONDO) y = nuova();
  y = banda(y, 'Dettaglio della scheda', ROSSO, '#fff');
  let sezione = null, n = 0;
  for (const v of voci) {
    if (v.sezione !== sezione) { sezione = v.sezione; if (sezione) { if (y + 40 > FONDO) y = nuova(); doc.font('Sans-B').fontSize(9).fillColor(ROSSO).text(String(sezione).toUpperCase(), L + 4, y + 2, { width: W - 8, lineBreak: false }); y += 16; n = 0; } }
    y = riga(v, y, n++, false);
  }
  for (const b of blocchi) {                                            // skill incorporate: stesso formato, con subtotale, giudizio ed errori gravi propri
    if (y + 70 > FONDO) y = nuova();
    y += 10; y = banda(y, `${/^skill/i.test(b.nome) ? b.nome : 'Skill · ' + b.nome}   —   ${b.punti} / ${b.massimo}${b.giudizio ? '  ·  ' + b.giudizio : ''}`, '#1F2937', '#fff');
    b.voci.forEach((v, i) => { y = riga(v, y, i, true); });
    if (b.erroriGravi?.length) { const t = 'Errori gravi: ' + b.erroriGravi.join(' · '); if (y + 24 > FONDO) y = nuova(); doc.font('Sans').fontSize(8.5).fillColor('#8a1c1c').text(t, L + 6, y + 4, { width: W - 12 }); y += doc.heightOfString(t, { width: W - 12 }) + 8; }
    doc.fillColor('#000');
  }

  // ── firme ──
  if (y + 70 > FONDO) y = nuova();
  y += 34;
  doc.moveTo(L, y).lineTo(L + W / 2 - 20, y).strokeColor('#333').lineWidth(0.6).stroke(); doc.moveTo(L + W / 2 + 20, y).lineTo(L + W, y).stroke();
  doc.fillColor('#555').font('Sans').fontSize(8.5).text('Firma dell\'istruttore / valutatore', L, y + 4, { lineBreak: false }).text('Firma del candidato', L + W / 2 + 20, y + 4, { lineBreak: false });

  // piè di pagina con numerazione
  const pag = doc.bufferedPageRange();
  for (let i = 0; i < pag.count; i++) {
    doc.switchToPage(i); doc.page.margins.bottom = 0;
    doc.moveTo(L, doc.page.height - 38).lineTo(L + W, doc.page.height - 38).strokeColor('#D5D8DE').lineWidth(0.5).stroke();
    doc.fillColor('#777').font('Sans').fontSize(8).text(`${candidato.nome} · ${titolo}`, L, doc.page.height - 30, { width: W - 80, lineBreak: false, ellipsis: true })
      .text(`Pagina ${i + 1} di ${pag.count}`, L + W - 80, doc.page.height - 30, { width: 80, align: 'right', lineBreak: false });
  }
  doc.end(); return fine;
}
