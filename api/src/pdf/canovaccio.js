import { fileURLToPath } from 'node:url';
// Canovaccio di scena in PDF: copertina rossa con la lettera, riquadri per briefing/avvisi, triage a pillole, una scheda per paziente, fabbisogno.
import PDFDocument from 'pdfkit';

const FONT_R = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url));
const FONT_B = fileURLToPath(new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url));
const C = { rosso: '#D8232A', inchiostro: '#1E2430', grigio: '#667085', linea: '#D9DEE5', fondo: '#F5F6F8', carta: '#FFFFFF', ambra: '#FFF4D6', ambraBordo: '#E0A800', azzurro: '#EAF0F7', azzurroBordo: '#5B7C99', rosa: '#FCEEEE' };
const GRAV = { rosso: { c: '#D64545', t: 'ROSSO · T1' }, giallo: { c: '#E3A91B', t: 'GIALLO · T2' }, verde: { c: '#3E9A5B', t: 'VERDE · T3' }, bianco: { c: '#9AA3AF', t: 'BIANCO' } };
const W = 595.28, H = 841.89, M = 42, LARG = W - 2 * M, FONDO_PAG = 792;

export function creaCanovaccio(can) {
  const d = can.dati; const f = can.fabbisogno || {};
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true, autoFirstPage: false, info: { Title: `Canovaccio ${can.codice} – ${can.titolo}`, Producer: 'GPSER-2026' } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-Bold', FONT_B);
  let y = 0;
  const alt = (t, w, size, bold = false, gap = 2) => { doc.font(bold ? 'Sans-Bold' : 'Sans').fontSize(size); return doc.heightOfString(String(t), { width: w, lineGap: gap }); };
  const testo = (t, x, yy, w, { size = 10, bold = false, color = C.inchiostro, align = 'left', gap = 2 } = {}) => {
    doc.font(bold ? 'Sans-Bold' : 'Sans').fontSize(size).fillColor(color).text(String(t), x, yy, { width: w, align, lineGap: gap }); return alt(t, w, size, bold, gap);
  };
  const nuova = () => { doc.addPage(); y = M; };
  const serve = (h) => { if (y + h > FONDO_PAG) nuova(); };
  const pillola = (t, x, yy, colore, { size = 7.5, pad = 7, h = 15 } = {}) => {
    doc.font('Sans-Bold').fontSize(size); const w = doc.widthOfString(t) + pad * 2;
    doc.roundedRect(x, yy, w, h, h / 2).fill(colore); doc.fillColor('#FFFFFF').text(t, x + pad, yy + (h - size) / 2 + 0.6, { lineBreak: false }); return w;
  };
  const titoloSez = (t) => {
    serve(40); y += 6; doc.rect(M, y + 1, 5, 14).fill(C.rosso);
    testo(t, M + 14, y, LARG - 14, { size: 13, bold: true }); y += 17; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.6).strokeColor(C.linea).stroke(); y += 9;
  };

  // ── copertina ──
  doc.addPage();
  doc.rect(0, 0, W, 138).fill(C.rosso);
  doc.rect(0, 138, W, 5).fill('#A81A20');
  doc.roundedRect(M, 34, 78, 78, 10).fill('#FFFFFF');
  doc.font('Sans-Bold').fontSize(58).fillColor(C.rosso).text(can.codice, M, 42, { width: 78, align: 'center', lineBreak: false });
  const xT = M + 98, wT = W - M - xT;
  testo(`CANOVACCIO · ${can.versione === 'olimpiadi' ? 'OLIMPIADI' : 'GARA'} DI PRIMO SOCCORSO`, xT, 36, wT, { size: 8.5, bold: true, color: '#FFD9DB' });
  const hT = testo(can.titolo, xT, 52, wT, { size: 25, bold: true, color: '#FFFFFF', gap: 0 });
  if (d.sottotitolo) testo('«' + d.sottotitolo + '»', xT, 56 + hT, wT, { size: 11, color: '#FFE9EA' });
  // dati rapidi
  y = 160; let x = M;
  const chip = (e, v) => { doc.font('Sans').fontSize(8); const we = doc.widthOfString(e); doc.font('Sans-Bold').fontSize(10); const wv = doc.widthOfString(String(v)); const w = we + wv + 24;
    if (x + w > W - M) { x = M; y += 26; }
    doc.roundedRect(x, y, w, 20, 10).fill(C.fondo); testo(e, x + 10, y + 6.5, we + 2, { size: 8, color: C.grigio }); testo(v, x + 14 + we, y + 5.5, wv + 2, { size: 10, bold: true }); x += w + 8; };
  if (can.tempo_min) chip('Tempo', `${can.tempo_min} minuti`);
  if (d.squadra || can.versione === 'gara') chip('Squadra', d.squadra || '1 Team Leader + 4 soccorritori');
  chip('Pazienti', d.pazienti.length);
  if (f.simulatori != null) chip('Simulatori', f.simulatori);
  y += 30;
  // semaforo del triage
  if (d.triage.length) { let xs = M; testo('Triage', xs, y + 3, 40, { size: 8.5, color: C.grigio }); xs += 42;
    for (const t of d.triage) { const g = GRAV[t.gravita] || GRAV.bianco; doc.circle(xs + 7, y + 7, 7).fill(g.c); testo(t.n, xs, y + 3.2, 14, { size: 8, bold: true, color: '#FFFFFF', align: 'center' }); xs += 19; }
    y += 24; }

  // ── sezioni di testo ──
  for (const s of d.sezioni) {
    if (!s.blocchi.length) continue;
    titoloSez(s.titolo);
    const blocchi = []; for (const b of s.blocchi) { const u = blocchi[blocchi.length - 1]; if (b.tipo === 'testo' && u?.tipo === 'testo') u.testo += '\n' + b.testo; else blocchi.push({ ...b }); }
    for (const b of blocchi) {
      if (b.tipo === 'testo') { const h = alt(b.testo, LARG - 26, 10.2, false, 3) + 18; serve(Math.min(h, 120));
        if (y + h > FONDO_PAG) { /* testo lungo: spezzato su due pagine */ }
        if (s.tipo === 'briefing') { doc.roundedRect(M, y, LARG, h, 4).fill(C.rosa); doc.rect(M, y, 3.5, h).fill(C.rosso); } else { doc.roundedRect(M, y, LARG, h, 4).fill(C.fondo); }
        testo(b.testo, M + 14, y + 9, LARG - 26, { size: 10.2, gap: 3 }); y += h + 7; }
      else if (b.tipo === 'master') { const h = alt(b.testo, LARG - 30, 10, true, 2) + 16; serve(h); doc.roundedRect(M, y, LARG, h, 4).fill(C.azzurro); doc.rect(M, y, 3.5, h).fill(C.azzurroBordo);
        testo(b.testo, M + 14, y + 8, LARG - 26, { size: 10, bold: true, color: '#2F4A63', gap: 2 }); y += h + 7; }
      else if (b.tipo === 'avviso') {
        const crit = s.tipo === 'protocollo' || /NON entra|obbligator/i.test(b.titolo + b.testo); const bg = crit ? C.rosa : C.ambra, bo = crit ? C.rosso : C.ambraBordo;
        const ht = alt(b.titolo, LARG - 28, 10.2, true, 2), hb = b.testo ? alt(b.testo, LARG - 28, 10, false, 2.5) : 0; const h = ht + hb + (hb ? 6 : 0) + 18; serve(h);
        doc.roundedRect(M, y, LARG, h, 4).fill(bg); doc.roundedRect(M, y, LARG, h, 4).lineWidth(0.8).strokeColor(bo).stroke(); doc.rect(M, y, 3.5, h).fill(bo);
        testo(b.titolo, M + 14, y + 9, LARG - 28, { size: 10.2, bold: true, color: crit ? '#8E1218' : '#7A5A00', gap: 2 }); if (b.testo) testo(b.testo, M + 14, y + 9 + ht + 6, LARG - 28, { size: 10, gap: 2.5 });
        y += h + 7; }
      else if (b.tipo === 'tabella') { for (const r of b.righe) { const h = Math.max(...r.map((c) => alt(c, LARG / r.length - 10, 9.5))) + 8; serve(h);
        r.forEach((c, i) => testo(c, M + 5 + i * (LARG / r.length), y + 4, LARG / r.length - 10, { size: 9.5 })); y += h; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.4).strokeColor(C.linea).stroke(); } y += 6; }
    }
  }

  // ── triage ──
  if (d.triage.length) {
    serve(44 + d.triage.length * 31); titoloSez('Ordine di gravità · triage');
    for (const t of d.triage) {
      const g = GRAV[t.gravita] || GRAV.bianco; const hp = Math.max(alt(t.patologia, 205, 9.5), alt(t.paziente, 140, 10, true)) + 14; serve(hp);
      doc.roundedRect(M, y, LARG, hp, 5).fill(C.fondo); doc.rect(M, y + 4, 3.5, hp - 8).fill(g.c);
      doc.circle(M + 24, y + hp / 2, 10).fill(g.c); testo(t.n, M + 14, y + hp / 2 - 5, 20, { size: 10.5, bold: true, color: '#FFFFFF', align: 'center' });
      testo(t.paziente, M + 44, y + 7, 140, { size: 10, bold: true }); testo(t.patologia, M + 192, y + 7, 205, { size: 9.5, color: C.grigio });
      doc.font('Sans-Bold').fontSize(7.5); const lab = (t.codice || g.t).replace(/\s*[–-]\s*/, ' · '); pillola(lab, W - M - 12 - (doc.widthOfString(lab) + 14), y + hp / 2 - 7.5, g.c); y += hp + 5;
    }
  }

  // ── pazienti ──
  if (d.pazienti.length) {
    serve(200); titoloSez('Schede pazienti');
    for (const p of d.pazienti) {
      const g = GRAV[p.gravita] || GRAV.bianco; const xi = M + 14, wi = LARG - 28, wLab = 82, wVal = wi - wLab - 6;
      const par = (p.parametri || '').split(/\s+[–—-]\s+/).map((x) => x.trim()).filter(Boolean); const ok = par.length === 4;
      const hCos = p.coscienza ? alt(p.coscienza, wi - 70, 9.6, false, 2) : 0;
      const hPar = p.parametri ? (ok ? 40 : alt(p.parametri, wi - 70, 9.6) + 6) : 0;
      const righe = p.righe.map((r) => ({ ...r, h: Math.max(alt(r.v, wVal - (r.tipo === 'dato' ? 0 : 14), 9.6, false, 2), 11) + 9 }));
      const hCard = 40 + Math.max(hCos + 8, p.coscienza ? 20 : 0) + hPar + (hPar ? 6 : 0) + righe.reduce((a, r) => a + r.h, 0) + 8;
      serve(Math.min(hCard, 300)); const y0 = y;
      doc.roundedRect(M, y, LARG, 36, 6).fill(g.c);
      doc.roundedRect(M, y + 10, LARG, 26, 0).fill(g.c);
      doc.circle(M + 21, y + 18, 11).fill('#FFFFFF'); testo(p.n ?? '', M + 10, y + 12.3, 22, { size: 12, bold: true, color: g.c, align: 'center' });
      testo(p.nome, M + 40, y + 6, LARG - 190, { size: 12.5, bold: true, color: '#FFFFFF', gap: 0 });
      testo(p.patologia, M + 40, y + 21, LARG - 150, { size: 9, color: '#FFFFFF', gap: 0 });
      doc.font('Sans-Bold').fontSize(7.5); const lab = g.t; doc.roundedRect(W - M - 10 - (doc.widthOfString(lab) + 14), y + 10, doc.widthOfString(lab) + 14, 15, 7.5).fill('#FFFFFF');
      testo(lab, W - M - 10 - (doc.widthOfString(lab) + 7), y + 14.2, doc.widthOfString(lab) + 4, { size: 7.5, bold: true, color: g.c });
      y += 36; doc.rect(M, y, LARG, 0).stroke();
      // corpo
      const yc = y; y += 8;
      if (p.coscienza) { testo('Coscienza', xi, y + 1, 62, { size: 8.5, bold: true, color: C.grigio }); testo(p.coscienza, xi + 70, y, wi - 70, { size: 9.6, gap: 2 }); y += Math.max(hCos, 11) + 8; }
      if (p.parametri) {
        if (ok) { const lab4 = ['FR', 'FC', 'PA', 'SpO₂'], pesi = [1.7, 1, 1.15, 0.8], tot = pesi.reduce((a, b) => a + b, 0), spazio = wi - 3 * 6; let xx = xi;
          const hb = Math.max(...par.map((v, i) => alt(v, spazio * pesi[i] / tot - 12, 8.6, true, 0))) + 17;
          par.forEach((v, i) => { const w4 = spazio * pesi[i] / tot; doc.roundedRect(xx, y, w4, hb, 4).fill(C.fondo);
            testo(lab4[i], xx + 7, y + 3.5, 30, { size: 7, bold: true, color: C.grigio }); testo(v, xx + 7, y + 13, w4 - 12, { size: 8.6, bold: true, gap: 0 }); xx += w4 + 6; }); y += hb + 6; }
        else { testo('Parametri', xi, y + 1, 62, { size: 8.5, bold: true, color: C.grigio }); testo(p.parametri, xi + 70, y, wi - 70, { size: 9.6 }); y += hPar; }
      }
      for (const r of righe) {
        if (y + r.h > FONDO_PAG) { // la scheda continua nella pagina dopo
          doc.rect(M, yc, 0.8, 0).stroke(); nuova(); y += 4; }
        if (r.tipo === 'nota') { doc.roundedRect(xi - 4, y - 3, wi + 8, r.h - 1, 3).fill(C.ambra); }
        else if (r.tipo === 'attore') { doc.roundedRect(xi - 4, y - 3, wi + 8, r.h - 1, 3).fill(C.azzurro); }
        testo(r.k, xi + (r.tipo === 'dato' ? 0 : 3), y, wLab - 4, { size: 8.5, bold: true, color: r.tipo === 'nota' ? '#7A5A00' : r.tipo === 'attore' ? '#2F4A63' : C.grigio });
        testo(r.v, xi + wLab + 6, y, wVal, { size: 9.6, gap: 2 }); y += r.h;
      }
      // cornice colorata della scheda
      if (y0 >= M - 1 && y - y0 < FONDO_PAG - M) doc.roundedRect(M, y0, LARG, y - y0 + 4, 6).lineWidth(0.9).strokeColor(g.c).stroke();
      y += 16;
    }
  }

  // ── logistica e fabbisogno ──
  if (d.logistica.length) {
    serve(220); titoloSez('Logistica e materiale di scena');
    const tile = [['Simulatori', f.simulatori], ['Manichini RCP', f.manichini_rcp], ['Attori extra', f.attori_extra], ['Truccatori', f.truccatori]].filter(([, v]) => v != null);
    const wt = (LARG - (tile.length - 1) * 8) / tile.length;
    tile.forEach(([l, v], i) => { const xx = M + i * (wt + 8); doc.roundedRect(xx, y, wt, 52, 6).fill(C.fondo); testo(v, xx, y + 7, wt, { size: 24, bold: true, color: C.rosso, align: 'center', gap: 0 }); testo(l, xx, y + 36, wt, { size: 8.5, color: C.grigio, align: 'center' }); });
    y += 62;
    for (const r of d.logistica) {
      const xv = M + 120, wv = LARG - 120;
      if (/^trucchi/i.test(r.k)) {
        const voci = r.v.split(/,\s*(?![^()]*\))/).map((x) => x.trim()).filter(Boolean);
        serve(20); testo(r.k, M, y + 1, 112, { size: 9, bold: true, color: C.grigio }); let first = true;
        for (const v of voci) { const m = /^(.*?)\s*\((semplice|medio|complesso)\)\s*$/i.exec(v); const nome = m ? m[1] : v, cx = m ? m[2].toLowerCase() : null; const h = alt(nome, wv - 70, 9.6) + 5; serve(h);
          if (!first) { /* righe successive */ } first = false;
          testo(nome, xv, y, wv - 70, { size: 9.6, gap: 2 }); if (cx) pillola(cx, W - M - 62, y - 1, cx === 'complesso' ? '#C0392B' : cx === 'medio' ? '#D68910' : '#5D8A66', { size: 7.2, h: 13, pad: 6 }); y += h; }
        y += 4; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.4).strokeColor(C.linea).stroke(); y += 6; continue;
      }
      const h = Math.max(alt(r.v, wv, 9.6, false, 2), 12) + 6; serve(h);
      testo(r.k, M, y + 1, 112, { size: 9, bold: true, color: C.grigio }); testo(r.v, xv, y, wv, { size: 9.6, gap: 2 }); y += h; doc.moveTo(M, y).lineTo(W - M, y).lineWidth(0.4).strokeColor(C.linea).stroke(); y += 6;
    }
  }

  // ── piè di pagina ──
  const n = doc.bufferedPageRange().count;
  for (let i = 0; i < n; i++) {
    doc.switchToPage(i); doc.moveTo(M, 806).lineTo(W - M, 806).lineWidth(0.5).strokeColor(C.linea).stroke();
    testo(`Canovaccio ${can.codice} · ${can.titolo} · ${can.versione === 'olimpiadi' ? 'Olimpiadi' : 'Gara'}`, M, 813, 360, { size: 8, color: C.grigio });
    testo(`Uso esclusivo per esercitazioni didattiche · pag. ${i + 1}/${n}`, W - M - 240, 813, 240, { size: 8, color: C.grigio, align: 'right' });
  }
  return doc;
}
