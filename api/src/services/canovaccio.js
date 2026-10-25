// Canovacci di scena: legge i .docx (briefing, descrizione, triage, schede pazienti, logistica) e li salva come dati strutturati.
import JSZip from 'jszip';
import { httpErr } from './compilazioni.js';

const NOMI = { ALFA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D', ECHO: 'E', FOXTROT: 'F', GOLF: 'G', HOTEL: 'H', INDIA: 'I', JULIET: 'J' };
const PICTO = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu;
const pulisci = (t) => String(t ?? '').replace(PICTO, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const ent = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

function testoParagrafo(xml) {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g)) out += m[0].startsWith('<w:t') ? ent(m[1]) : (m[0].startsWith('<w:br') ? '\n' : ' ');
  return out;
}
const paragrafi = (xml) => [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => testoParagrafo(m[0]));

// → [{ tipo:'p', testo } | { tipo:'t', righe:[[cella,…]] }] nell'ordine del documento
export function leggiElementi(xml) {
  const body = xml.slice(xml.indexOf('<w:body'));
  const out = [];
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g)) {
    if (m[0].startsWith('<w:tbl>')) {
      const righe = [...m[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) => [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => pulisci(paragrafi(c[0]).join('\n'))));
      out.push({ tipo: 't', righe: righe.map((r) => r.filter((c, i) => c || i === 0)).filter((r) => r.some(Boolean)) });
    } else { const t = pulisci(testoParagrafo(m[0])); if (t) out.push({ tipo: 'p', testo: t, grezzo: testoParagrafo(m[0]) }); }
  }
  return out;
}

const SEZ = [[/^Briefing/i, 'briefing'], [/^Protocollo/i, 'protocollo'], [/^Descrizione/i, 'descrizione'], [/^Scena (recitata|dinamica)/i, 'scena_recitata'],
  [/^Ordine di gravit|^Triage/i, 'triage'], [/^Schede Pazienti/i, 'pazienti'], [/^Logistica/i, 'logistica']];
const TITOLI = { briefing: 'Briefing per la squadra', protocollo: 'Protocollo di sicurezza', descrizione: 'Descrizione della scena', scena_recitata: 'Scena recitata', triage: 'Ordine di gravità', pazienti: 'Schede pazienti', logistica: 'Logistica e materiale di scena' };
const sezioneDi = (t) => { const f = SEZ.find(([re]) => re.test(t)); return f ? f[1] : null; };
const intero = (t) => { const m = /(\d+)/.exec(t || ''); return m ? Number(m[1]) : null; };
const GRAV = (t) => (/BIANCO|⚪/i.test(t) ? 'bianco' : /ROSSO|T1/i.test(t) ? 'rosso' : /GIALLO|T2/i.test(t) ? 'giallo' : /VERDE|T3/i.test(t) ? 'verde' : null);

function paziente(intest, righe) {
  const m = /Paziente\s+(\d+)\s*[–—-]\s*(.+?)\s*(?:\|\s*(.+))?$/s.exec(intest.replace(/\s+/g, ' ')) || [];
  const p = { n: Number(m[1]) || null, nome: (m[2] || intest).trim(), patologia: (m[3] || '').trim(), coscienza: '', parametri: '', righe: [] };
  for (const r of righe) {
    if (r.length < 2) { if (r[0]) p.righe.push({ k: 'Nota', v: r[0], tipo: 'nota' }); continue; }
    const k = r[0].replace(/\s+/g, ' ').trim(); const v = r.slice(1).join(' ').trim();
    if (/^Coscienza/i.test(k)) p.coscienza = v;
    else if (/^(FR\b|Parametri)/i.test(k)) p.parametri = v;
    else p.righe.push({ k, v, tipo: /^Attore/i.test(k) ? 'attore' : /^(Nota|Ricerca|Gestione|Evoluzione|Ruolo)/i.test(k) ? 'nota' : 'dato' });
  }
  return p;
}

export function calcolaFabbisogno(d) {
  const log = Object.fromEntries((d.logistica || []).map((r) => [r.k.toLowerCase(), r.v]));
  const trova = (re) => Object.entries(log).find(([k]) => re.test(k))?.[1] || '';
  const sim = intero(trova(/^simulatori/)) ?? (d.pazienti || []).length;
  const mt = trova(/^manichini/);
  const trucchi = { semplice: 0, medio: 0, complesso: 0 };
  for (const m of trova(/^trucchi/).matchAll(/\((semplice|medio|complesso)\)/gi)) trucchi[m[1].toLowerCase()]++;
  const extra = (re) => { const t = trova(re); return t ? (/non necessari|nessun/i.test(t) ? 0 : (/^\s*(\d+)/.exec(t)?.[1] ? Number(/^\s*(\d+)/.exec(t)[1]) : 1)) : 0; };
  const gr = { rosso: 0, giallo: 0, verde: 0, bianco: 0 }; for (const t of d.triage || []) if (gr[t.gravita] !== undefined) gr[t.gravita]++;
  return { simulatori: sim, manichini_rcp: !mt || /non necessari|^nessun/i.test(mt) ? 0 : (intero(mt) ?? 1), attori_extra: extra(/^attore/), trucchi,
    truccatori: trucchi.semplice + trucchi.medio + trucchi.complesso > 0 ? Math.max(1, Math.ceil((trucchi.semplice * 1 + trucchi.medio * 2 + trucchi.complesso * 4) / 6)) : 0, triage: gr };
}

export function interpretaCanovaccio(elementi, nomeFile = '') {
  const avvisi = [];
  const titoli = elementi.filter((e) => e.tipo === 'p').slice(0, 4);
  const mt = /^(\S+)\s*[–—-]\s*(.+)$/.exec(titoli[0]?.testo || '');
  if (!mt) throw httpErr(400, 'non riconosco il titolo del canovaccio (atteso «LETTERA – Titolo»)');
  const base = nomeFile.split(/[\\/]/).pop().toUpperCase();
  const dalFile = Object.keys(NOMI).find((n) => base.startsWith(n));
  const dalTitolo = NOMI[mt[1].toUpperCase()] || (/^[A-Z]$/.test(mt[1].toUpperCase()) ? mt[1].toUpperCase() : null);
  const codice = dalFile ? NOMI[dalFile] : dalTitolo;
  if (!codice) throw httpErr(400, 'non riesco a capire la lettera della scena');
  if (dalFile && dalTitolo && dalFile && NOMI[dalFile] !== dalTitolo) avvisi.push(`Il titolo dentro il file dice «${mt[1]}» ma il nome del file è ${dalFile}: uso ${NOMI[dalFile]}`);
  const iSez = elementi.findIndex((e) => e.tipo === 'p' && sezioneDi(e.testo));
  const riga2 = elementi.slice(1, iSez < 0 ? 4 : iSez).filter((e) => e.tipo === 'p').map((e) => e.testo);
  const meta = riga2.join(' ');
  const versione = /olimpiad/i.test(meta + ' ' + base) ? 'olimpiadi' : 'gara';
  const d = { sottotitolo: (riga2.find((t) => /^["“«]/.test(t)) || (/["“«][^"”»]+["”»]/.exec(meta) || [''])[0]).replace(/^["“«]|["”»]$/g, '').trim(), squadra: (/Squadra:\s*([^–—]+?)\s*$/i.exec(meta) || [])[1] || '', sezioni: [], triage: [], pazienti: [], logistica: [] };
  const tempo = /Tempo:\s*(\d+)/i.exec(meta);
  let sez = null; let corrente = null; let intestPaz = null;
  const apri = (tipo, titolo) => { corrente = { tipo, titolo: titolo || TITOLI[tipo] || tipo, blocchi: [] }; if (!['triage', 'pazienti', 'logistica'].includes(tipo)) d.sezioni.push(corrente); return corrente; };
  let i0 = elementi.findIndex((e) => e.tipo === 'p' && sezioneDi(e.testo));
  if (i0 < 0) throw httpErr(400, 'nel file non trovo le sezioni del canovaccio (Briefing, Descrizione, Pazienti…)');
  for (const e of elementi.slice(i0)) {
    if (e.tipo === 'p') {
      const s = sezioneDi(e.testo);
      if (s) { sez = s; apri(s, s === 'scena_recitata' ? e.testo : null); continue; }
      if (sez === 'pazienti' && /Paziente\s+\d+/i.test(e.testo)) { if (intestPaz) d.pazienti.push(paziente(intestPaz, [])); intestPaz = e.testo; continue; }
      if (!corrente || ['triage', 'pazienti', 'logistica'].includes(sez)) { if (e.testo.length > 3 && !/^Documento interno/i.test(e.testo)) avvisi.push('Testo fuori posto ignorato: ' + e.testo.slice(0, 60)); continue; }
      corrente.blocchi.push({ tipo: /^👉/.test(e.grezzo.trim()) ? 'master' : 'testo', testo: e.testo });
      continue;
    }
    const r = e.righe; if (!r.length) continue;
    if (sez === 'triage') {
      for (const x of r.slice(/^#$/.test(r[0][0]) ? 1 : 0)) d.triage.push({ n: intero(x[0]), paziente: x[1] || '', patologia: x[2] || '', codice: x[3] || '', gravita: GRAV(x[3] || '') });
    } else if (sez === 'pazienti') {
      if (intestPaz) { d.pazienti.push(paziente(intestPaz, r)); intestPaz = null; } else avvisi.push('Tabella pazienti senza intestazione');
    } else if (sez === 'logistica') {
      for (const x of r) if (x.length >= 2) d.logistica.push({ k: x[0], v: x.slice(1).join(' ') });
    } else if (corrente) {
      if (r.length === 1 && r[0].length === 1) { const [t, ...resto] = r[0][0].split('\n'); corrente.blocchi.push({ tipo: 'avviso', titolo: t, testo: resto.join('\n') }); }
      else if (r.every((x) => x.length === 1)) corrente.blocchi.push({ tipo: 'avviso', titolo: r[0][0].split('\n')[0], testo: r.map((x) => x[0]).join('\n').split('\n').slice(1).join('\n') });
      else corrente.blocchi.push({ tipo: 'tabella', righe: r });
    }
  }
  if (intestPaz) d.pazienti.push(paziente(intestPaz, []));
  // gravità dei pazienti dal triage: per numero «(P2)» oppure per nome
  const nn = (t) => String(t || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
  const presi = new Set();
  const assegna = (t, p) => { p.gravita = t.gravita; p.ordine = t.n; presi.add(p); };
  for (const t of d.triage) { const n = /\(P(\d+)\)/i.exec(t.paziente)?.[1]; const p = n ? d.pazienti.find((x) => x.n === Number(n)) : d.pazienti.find((x) => !presi.has(x) && nn(x.nome) === nn(t.paziente)); if (p) assegna(t, p); else t.libero = true; }
  for (const t of d.triage.filter((x) => x.libero)) { delete t.libero; const p = d.pazienti.find((x) => !presi.has(x) && (nn(x.nome).includes(nn(t.paziente)) || nn(t.paziente).includes(nn(x.nome)))); if (p) assegna(t, p); }
  if (!d.pazienti.length) avvisi.push('Nessuna scheda paziente trovata');
  const senza = d.pazienti.filter((p) => !p.gravita && !/gestion|comunicativ|disturbo/i.test(p.patologia));
  if (senza.length) avvisi.push('Pazienti non presenti nella tabella di triage: ' + senza.map((p) => p.nome).join(', '));
  d.fabbisogno = undefined;
  return { codice, versione, titolo: mt[2].trim(), tempo_min: tempo ? Number(tempo[1]) : (JSON.stringify(d.sezioni).match(/Tempo:\s*(\d+)\s*minut/i) || [])[1] * 1 || null, dati: d, fabbisogno: calcolaFabbisogno(d), avvisi };
}

export async function leggiDocx(buf) {
  const zip = await JSZip.loadAsync(buf).catch(() => { throw httpErr(400, 'non è un file .docx'); });
  const f = zip.file('word/document.xml'); if (!f) throw httpErr(400, 'non è un file .docx');
  return leggiElementi(await f.async('string'));
}

export async function importaCanovaccio(db, buf, nomeFile) {
  const c = interpretaCanovaccio(await leggiDocx(buf), nomeFile);
  const { rows: [r] } = await db.query(
    `insert into canovaccio (codice, versione, titolo, tempo_min, dati, fabbisogno) values ($1,$2,$3,$4,$5,$6)
     on conflict (codice, versione) do update set titolo=excluded.titolo, tempo_min=excluded.tempo_min, dati=excluded.dati, fabbisogno=excluded.fabbisogno, updated_at=now()
     returning id, (xmax = 0) as nuovo`, [c.codice, c.versione, c.titolo, c.tempo_min, c.dati, c.fabbisogno]);
  return { id: r.id, codice: c.codice, versione: c.versione, titolo: c.titolo, nuovo: r.nuovo, pazienti: c.dati.pazienti.length, fabbisogno: c.fabbisogno, avvisi: c.avvisi };
}
