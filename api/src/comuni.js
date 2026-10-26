// Elenco dei comuni italiani con regione, provincia e coordinate (dati ISTAT, pacchetto «italian-cap-comuni-province», MIT). Tutto in memoria: nessun servizio esterno.
import { readFileSync } from 'node:fs';
const RIGHE = JSON.parse(readFileSync(new URL('./dati/comuni.json', import.meta.url), 'utf8'));
export const COMUNI = RIGHE.map(([istat, nome, sigla, provincia, regione, lat, lng]) => ({ istat, nome, sigla, provincia, regione, lat, lng }));
const PER_ISTAT = new Map(COMUNI.map((c) => [c.istat, c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NORM = COMUNI.map((c) => ({ c, n: norm(c.nome) }));

export const comunePerIstat = (istat) => PER_ISTAT.get(String(istat || '')) || null;
export const etichettaLuogo = (c) => `${c.nome} (${c.sigla})`;
export const regioni = () => [...new Set(COMUNI.map((c) => c.regione))].sort((a, b) => a.localeCompare(b, 'it'));
export const province = (regione) => {
  const m = new Map(); for (const c of COMUNI) if (!regione || c.regione === regione) m.set(c.sigla, c.provincia);
  return [...m].map(([sigla, nome]) => ({ sigla, nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
};
export function cerca({ regione, provincia, q } = {}, limite = 60) {
  const nq = norm(q);
  let r = NORM.filter(({ c, n }) => (!regione || c.regione === regione) && (!provincia || c.sigla === provincia) && (!nq || n.includes(nq)));
  if (nq) r.sort((a, b) => (b.n.startsWith(nq) - a.n.startsWith(nq)) || a.n.length - b.n.length);
  return r.slice(0, limite).map(({ c }) => c);
}
// «Carpi (MO)», «Modena», «Reggio Emilia - Fiera»: ricava il comune da un luogo scritto a mano (usato per gli eventi già inseriti)
export function comuneDaLuogo(luogo) {
  const testo = String(luogo || ''); if (!testo.trim()) return null;
  const sig = testo.match(/\(([A-Za-z]{2})\)/)?.[1]?.toUpperCase();
  const n = norm(testo.replace(/\(.*?\)/g, ' '));
  let best = null;
  for (const { c, n: nc } of NORM) {
    if (sig && c.sigla !== sig) continue;
    if (n === nc || n.startsWith(nc + ' ') || n.endsWith(' ' + nc) || n.includes(' ' + nc + ' ')) { if (!best || nc.length > norm(best.nome).length) best = c; }
  }
  return best;
}
