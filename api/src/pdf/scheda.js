// Disegno della scheda A4 (stessa griglia delle schede Excel attuali).
// Tutto in coordinate "px a 110 dpi" del PDF di riferimento, convertite in punti con K.
import PDFDocument from 'pdfkit';
import fs from 'node:fs';

const K = 595.28 / 909;                     // px → pt
const FONT_R = new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url).pathname;
const FONT_B = new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url).pathname;
const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const X0 = 27, X1 = 883, XL = 488;           // bordo sx, bordo dx, inizio colonne livelli
const COLW = (X1 - XL) / 5;
const GRIGIO = '#E7E6E6';
const LIVELLI = [
  { k: 'mb', etichetta: ['MOLTO', 'BENE'], colore: '#2E7D32', faccia: 'felice' },
  { k: 'be', etichetta: ['BENE'], colore: '#2E7D32', faccia: 'sorriso' },
  { k: 'su', etichetta: ['SODDISFA', 'CENTE'], colore: '#1F4FD8', faccia: 'neutra' },
  { k: 'in', etichetta: ['INSUFFIC', 'IENTE'], colore: '#C62828', faccia: 'triste' },
  { k: 'ne', etichetta: ['NON', 'ESEGUITO'], colore: '#C62828', faccia: 'no' },
];
const p = (v) => v * K;

export function creaDocumento() {
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false,
    info: { Title: 'Schede di valutazione', Producer: 'GareCRI' } });
  doc.registerFont('Sans', FONT_R);          // Liberation Sans (licenza OFL): copre i caratteri latini estesi
  doc.registerFont('Sans-Bold', FONT_B);
  return doc;
}

// riduce il carattere fino a un minimo e poi tronca con "…": il testo non esce mai dalla cella
function adatta(doc, s, larghezza, font, size, min = 6) {
  s = String(s);
  doc.font(font);
  let sz = size;
  while (sz > min && doc.fontSize(sz).widthOfString(s) > larghezza) sz -= 0.25;
  doc.fontSize(sz);
  if (doc.widthOfString(s) <= larghezza) return { s, sz };
  while (s.length > 1 && doc.widthOfString(s + '…') > larghezza) s = s.slice(0, -1);
  return { s: s + '…', sz };
}

function rect(doc, x, y, w, h, { fill, stroke = '#000', lw = 0.7 } = {}) {
  doc.save().lineWidth(lw);
  if (fill) doc.rect(p(x), p(y), p(w), p(h)).fillAndStroke(fill, stroke);
  else doc.rect(p(x), p(y), p(w), p(h)).stroke(stroke);
  doc.restore();
}
function testo(doc, s, x, y, w, h, { size = 10, font = 'Sans', align = 'center', color = '#000', valign = 'middle', pad = 4, multi = false } = {}) {
  doc.save().fillColor(color);
  if (multi) {                                   // blocchi su più righe (parametri del simulatore)
    doc.font(font).fontSize(size);
    const alt = doc.heightOfString(String(s), { width: p(w - 2 * pad) });
    doc.text(String(s), p(x + pad), valign === 'middle' ? p(y) + (p(h) - alt) / 2 : p(y) + 2, { width: p(w - 2 * pad), align });
  } else {
    const a = adatta(doc, s, p(w - 2 * pad), font, size);
    const ty = valign === 'middle' ? p(y) + (p(h) - doc.currentLineHeight()) / 2 + 0.6 : p(y) + 2;
    doc.text(a.s, p(x + pad), ty, { width: p(w - 2 * pad), align, lineBreak: false });
  }
  doc.restore();
}

function faccia(doc, tipo, cx, cy, r, colore) {
  doc.save().lineWidth(1).strokeColor(colore).fillColor(colore);
  if (tipo === 'no') {                         // pollice verso (stilizzato)
    doc.moveTo(cx - r * .5, cy - r * .6).lineTo(cx + r * .5, cy - r * .6).lineTo(cx + r * .2, cy + r * .7)
      .lineTo(cx - r * .2, cy + r * .7).closePath().fill();
    doc.restore(); return;
  }
  doc.circle(cx, cy, r).stroke();
  doc.circle(cx - r * .35, cy - r * .25, r * .1).fill();
  doc.circle(cx + r * .35, cy - r * .25, r * .1).fill();
  if (tipo === 'felice' || tipo === 'sorriso') doc.moveTo(cx - r * .5, cy + r * .25).quadraticCurveTo(cx, cy + r * .9, cx + r * .5, cy + r * .25).stroke();
  else if (tipo === 'neutra') doc.moveTo(cx - r * .45, cy + r * .45).lineTo(cx + r * .45, cy + r * .45).stroke();
  else doc.moveTo(cx - r * .5, cy + r * .6).quadraticCurveTo(cx, cy, cx + r * .5, cy + r * .6).stroke();
  doc.restore();
}

/**
 * ctx: { evento, squadra, scena, scheda, voci, compilazione|null, risposte: Map(voceId→livello), vuota }
 */
export function disegnaScheda(doc, ctx) {
  const { evento, squadra, scena, scheda, voci, compilazione, risposte, vuota } = ctx;
  doc.addPage();

  // intestazione
  doc.image(LOGO, p(25), p(25), { width: p(120) });
  doc.image(LOGO, p(760), p(25), { width: p(120) });
  testo(doc, 'Croce Rossa Italiana', 145, 28, 615, 50, { size: 18, font: 'Sans-Bold', color: '#E3001B' });
  testo(doc, evento.titolo_stampa || evento.nome, 145, 72, 615, 34, { size: 12.5, font: 'Sans-Bold' });
  const dataTxt = evento.data_txt
    ? new Date(`${evento.data_txt}T00:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .replace(/ ([a-z])/, (m, c) => ` ${c.toUpperCase()}`) : '';
  testo(doc, [evento.luogo, dataTxt].filter(Boolean).join(' '), 27, 128, 856, 34, { size: 13, font: 'Sans-Bold' });

  // blocco identificativo
  const sim = scheda.simulatore;
  const codice = `${scena.codice}${String(squadra.numero).padStart(2, '0')}${sim}`;
  rect(doc, X0, 173, 158, 43);
  testo(doc, codice, X0, 173, 158, 43, { size: 24, font: 'Courier' });
  rect(doc, 185, 173, 217, 22); rect(doc, 185, 195, 217, 21);
  testo(doc, 'Scena', 185, 173, 217, 22, { size: 9.5 });
  testo(doc, scena.codice, 185, 195, 217, 21, { size: 9.5, font: 'Sans-Bold' });
  rect(doc, 402, 173, 86, 22); rect(doc, 402, 195, 86, 21);
  testo(doc, 'Simulatore', 402, 173, 86, 22, { size: 9.5 });
  testo(doc, sim === 'M' ? '' : sim, 402, 195, 86, 21, { size: 9.5, font: 'Sans-Bold' });
  rect(doc, 488, 173, 79, 43); rect(doc, 567, 173, 316, 43);
  testo(doc, 'Giudice', 488, 173, 79, 43, { size: 11 });
  if (!vuota && compilazione?.giudice) testo(doc, compilazione.giudice, 567, 173, 316, 43, { size: 11, font: 'Sans-Bold' });
  rect(doc, X0, 216, 158, 21); rect(doc, 185, 216, 303, 21);
  testo(doc, 'Squadra', X0, 216, 158, 21, { size: 9.5 });
  testo(doc, `${squadra.numero}-${squadra.nome}`, 185, 216, 303, 21, { size: 9.5, font: 'Sans-Bold' });
  rect(doc, X0, 237, 461, 44);
  testo(doc, scena.titolo, X0, 237, 461, 44, { size: 14, font: 'Sans-Bold' });
  // parametri del simulatore: griglia sulle stesse colonne dei livelli (vuota per le schede senza parametri, es. Master)
  const par = scheda.parametri || {};
  const campi = [['Coscienza', par.coscienza], ['FR', par.fr], ['FC', par.fc], ['Cute', par.cute]];
  if (campi.some(([, v]) => v != null && v !== '')) {
    rect(doc, XL, 216, COLW, 21); rect(doc, XL, 237, COLW, 44);
    testo(doc, 'Parametri', XL, 237, COLW, 44, { size: 9.5 });
    campi.forEach(([n, v], i) => {
      const x = XL + (i + 1) * COLW;
      rect(doc, x, 216, COLW, 21); rect(doc, x, 237, COLW, 44);
      testo(doc, n, x, 216, COLW, 21, { size: 9.5 });
      testo(doc, v == null ? '' : String(v), x, 237, COLW, 44, { size: 9.5, multi: true });
    });
  } else { rect(doc, XL, 216, X1 - XL, 21); rect(doc, XL, 237, X1 - XL, 44); }

  // intestazione colonne
  rect(doc, X0, 281, 461, 99);
  testo(doc, scheda.titolo, X0, 281, 461, 99, { size: 14, font: 'Sans-Bold' });
  LIVELLI.forEach((l, i) => {
    const x = XL + i * COLW;
    rect(doc, x, 281, COLW, 72); rect(doc, x, 353, COLW, 27);
    doc.save().font('Courier-Bold').fontSize(7.8).fillColor(l.colore);
    const cx = p(x + COLW / 2), cy = p(281 + 36);
    doc.translate(cx, cy).rotate(-90);
    l.etichetta.forEach((riga, j) => {
      const off = (j - (l.etichetta.length - 1) / 2) * 9;
      doc.text(riga, -p(30), off - 3.6, { width: p(60), align: 'center', lineBreak: false });
    });
    doc.restore();
    faccia(doc, l.faccia, p(x + COLW / 2), p(366), p(8.5), l.colore);
  });

  // voci: il testo va a capo (fino a 3 righe) e le righe crescono; se non entra in pagina si rimpicciolisce
  // il carattere e si comprime l'altezza minima. Con tutto il possibile compresso si rifiuta, mai si tronca in silenzio.
  const yInizio = 380, yFine = 1068, LARG = p(461 - 6);
  const rr = [];
  let prec = null;
  for (const v of voci) {
    if (v.sezione !== prec) { rr.push({ tipo: 'sezione', testo: v.sezione }); prec = v.sezione; }
    rr.push({ tipo: 'voce', v, testo: v.testo });
  }
  const misura = (size, base) => rr.map((r) => {
    doc.font('Sans').fontSize(size);
    const linee = Math.min(3, Math.max(1, Math.ceil(doc.widthOfString(r.testo) / (LARG * 0.97))));
    return Math.max(base, (linee * size * 1.17 + 5) / K);
  });
  let layout = null;
  for (const size of [9.5, 8.5, 7.5, 6.5]) {
    for (const base of [21.3, 18, 15, 13]) {
      const hs = misura(size, base);
      if (hs.reduce((a, b) => a + b, 0) <= yFine - yInizio) { layout = { size, hs }; break; }
    }
    if (layout) break;
  }
  if (!layout) throw Object.assign(new Error(`scheda "${scheda.titolo}" troppo lunga per una pagina`), { statusCode: 400 });
  let y = yInizio;
  rr.forEach((r, i) => {
    const h = layout.hs[i];
    if (r.tipo === 'sezione') {
      rect(doc, X0, y, 461, h, { fill: GRIGIO });
      testo(doc, r.testo, X0, y, 461, h, { size: layout.size, align: 'left', pad: 3, multi: true });
      rect(doc, XL, y, X1 - XL, h, { fill: '#000' });
    } else {
      const v = r.v;
      rect(doc, X0, y, 461, h);
      testo(doc, v.testo, X0, y, 461, h, { size: layout.size, align: 'left', pad: 3, multi: true });
      const scelto = vuota ? null : risposte.get(v.id);
      LIVELLI.forEach((l, j) => {
        const x = XL + j * COLW;
        if (v[l.k] === null || v[l.k] === undefined) rect(doc, x, y, COLW, h, { fill: '#000' });
        else {
          rect(doc, x, y, COLW, h);
          if (scelto && scelto.toLowerCase() === l.k) testo(doc, 'X', x, y, COLW, h, { size: 10.5 });
        }
      });
    }
    y += h;
  });
  // riga vuota di chiusura + note + firma
  const yn = 1085;
  rect(doc, X0, yn, 620, 83); testo(doc, 'Note', X0, yn, 620, 20, { size: 9.5, align: 'left', pad: 3, valign: 'top' });
  rect(doc, 647, yn, 236, 20); rect(doc, 647, yn + 20, 236, 63);
  testo(doc, 'Firma giudice', 647, yn, 236, 20, { size: 9.5 });
  rect(doc, X0, 1168, 856, 20, { fill: GRIGIO });
  if (vuota) return;
  if (compilazione?.stato) {
    testo(doc, compilazione.stato === 'bozza' ? 'BOZZA' : '', X0, 1168, 856, 20, { size: 8, color: '#C62828' });
  }
}
