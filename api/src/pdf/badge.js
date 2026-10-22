// Badge (cartellino) in PDF: una pagina per persona, nel formato scelto (larghezza × altezza in mm).
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import { RUOLI_BADGE } from '../ruoli-gara.js';

const FONT_R = new URL('../../../assets/fonts/LiberationSans-Regular.ttf', import.meta.url).pathname;
const FONT_B = new URL('../../../assets/fonts/LiberationSans-Bold.ttf', import.meta.url).pathname;
const LOGO = fs.readFileSync(new URL('../../../assets/logo-cri.jpg', import.meta.url));
const mm = (v) => (Number(v) * 72) / 25.4;
const ROSSO = '#C8102E';

function adatta(doc, testo, larghezza, font, size, min = 5) {
  let s = String(testo); doc.font(font); let sz = size;
  while (sz > min && doc.fontSize(sz).widthOfString(s) > larghezza) sz -= 0.25;
  doc.fontSize(sz);
  if (doc.widthOfString(s) > larghezza) { while (s.length > 1 && doc.widthOfString(s + '…') > larghezza) s = s.slice(0, -1); s += '…'; }
  return s;
}
const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
const maiuscolo = (s) => String(s || '').toLocaleUpperCase('it-IT');

function testo(doc, s, x, y, w, { font = 'Sans', size = 10, colore = '#000', align = 'center', min = 5 } = {}) {
  const t = adatta(doc, s, w, font, size, min);
  doc.fillColor(colore).text(t, x, y, { width: w, align, lineBreak: false });
  return doc._fontSize;   // altezza indicativa per impilare le righe
}

function disegnaBadge(doc, W, H, evento, i) {
  const ver = H > W * 1.1;                          // formato verticale (es. 6 × 9)
  const m = Math.min(W, H) * 0.05;
  const ruolo = RUOLI_BADGE[i.ruolo] || { nome: i.ruolo, colore: '#444444' };
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  // fascia alta: logo e titolo della gara
  const hA = H * (ver ? 0.36 : 0.29);
  doc.rect(0, 0, W, hA).fill(ROSSO);
  const luogoData = [evento.luogo, dataIt(evento.data)].filter(Boolean).join(' · ');
  const titolo = evento.titolo_stampa || (evento.tipo === 'olimpiadi' ? 'Olimpiadi di primo soccorso' : 'Gara di primo soccorso');
  if (ver) {
    const L = hA * 0.30; doc.roundedRect((W - L) / 2, m * 0.7, L, L, L * 0.12).fill('#FFFFFF'); doc.image(LOGO, (W - L) / 2 + L * 0.06, m * 0.7 + L * 0.06, { width: L * 0.88 });
    let y = m * 0.7 + L + m * 0.5;
    testo(doc, maiuscolo('Croce Rossa Italiana'), m, y, W - 2 * m, { font: 'Sans-Bold', size: 6.5, colore: '#FFFFFF' }); y += 9;
    testo(doc, titolo, m, y, W - 2 * m, { size: 7, colore: '#FFFFFF' }); y += 10;
    testo(doc, evento.nome, m, y, W - 2 * m, { font: 'Sans-Bold', size: 13, colore: '#FFFFFF', min: 7 }); y += 17;
    if (luogoData) testo(doc, luogoData, m, y, W - 2 * m, { size: 6.5, colore: '#FFFFFF' });
  } else {
    const L = hA - 2 * m * 0.8; doc.roundedRect(m, m * 0.8, L, L, L * 0.1).fill('#FFFFFF'); doc.image(LOGO, m + L * 0.05, m * 0.8 + L * 0.05, { width: L * 0.9 });
    const x = m * 1.6 + L, w = W - x - m;
    testo(doc, `${maiuscolo('Croce Rossa Italiana')} · ${titolo}`, x, m * 0.9, w, { size: 7, colore: '#FFFFFF', align: 'left' });
    testo(doc, evento.nome, x, m * 0.9 + 12, w, { font: 'Sans-Bold', size: 18, colore: '#FFFFFF', align: 'left', min: 9 });
    if (luogoData) testo(doc, luogoData, x, hA - m * 0.8 - 8, w, { size: 8, colore: '#FFFFFF', align: 'left' });
  }
  // fascia bassa: ruolo
  const hB = H * (ver ? 0.15 : 0.19);
  doc.rect(0, H - hB, W, hB).fill(ruolo.colore);
  const dimR = Math.min(hB * 0.52, 22);
  doc.font('Sans-Bold').fontSize(dimR);
  testo(doc, maiuscolo(ruolo.nome), m, H - hB + (hB - dimR * 1.05) / 2, W - 2 * m, { font: 'Sans-Bold', size: dimR, colore: '#FFFFFF', min: 6 });
  // centro: nome della persona, comitato, squadra
  const yTop = hA + m * 0.6, yBot = H - hB - m * 0.6, hC = yBot - yTop;
  const dCog = Math.min(hC * (ver ? 0.17 : 0.30), ver ? 21 : 28), dNom = dCog * 0.74;
  const dRiga = Math.max(6.5, dNom * 0.5), dSq = Math.max(7, dNom * 0.55);
  const riga = [i.comitato, i.provincia ? `(${i.provincia})` : ''].filter(Boolean).join(' ');
  const blocco = dCog * 1.18 + dNom * 1.35 + (riga ? dRiga * 1.4 : 0) + (i.squadra ? dSq * 1.3 : 0);
  let y = yTop + Math.max(0, (hC - blocco) / 2);                       // il blocco del nome sta al centro dello spazio libero
  testo(doc, maiuscolo(i.cognome), m, y, W - 2 * m, { font: 'Sans-Bold', size: dCog, colore: '#111111', min: 8 }); y += dCog * 1.18;
  testo(doc, i.nome, m, y, W - 2 * m, { size: dNom, colore: '#111111', min: 7 }); y += dNom * 1.35;
  if (riga) { testo(doc, riga, m, y, W - 2 * m, { size: dRiga, colore: '#555555' }); y += dRiga * 1.4; }
  if (i.squadra) testo(doc, `Squadra: ${i.squadra}`, m, y, W - 2 * m, { font: 'Sans-Bold', size: dSq, colore: ruolo.colore });
  doc.lineWidth(0.4).strokeColor('#BBBBBB').rect(0.2, 0.2, W - 0.4, H - 0.4).stroke();   // bordo sottile per il taglio
}

// iscritti: [{ cognome, nome, comitato, provincia, ruolo, squadra }]
export function generaBadge({ evento, formato, iscritti }) {
  const W = mm(formato.larghezza_mm), H = mm(formato.altezza_mm);
  const doc = new PDFDocument({ size: [W, H], margin: 0, autoFirstPage: false, info: { Title: `Badge ${evento.nome}`, Producer: 'GareCRI' } });
  doc.registerFont('Sans', FONT_R); doc.registerFont('Sans-Bold', FONT_B);
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const fine = new Promise((ok) => doc.on('end', ok));
  for (const i of iscritti) { doc.addPage({ size: [W, H], margin: 0 }); disegnaBadge(doc, W, H, evento, i); }
  doc.end();
  return fine.then(() => Buffer.concat(chunks));
}
