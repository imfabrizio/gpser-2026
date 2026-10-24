// Nomi dei comitati: normalizzazione, riconoscimento di sigle (SS = sulla Secchia) e somiglianza per i suggerimenti.
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\b(comitato|cri|croce rossa italiana|di|del|della|dei)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const sigla = (parole) => parole.map((w) => w[0]).join('');
// "prignano ss" ~ "prignano sulla secchia": il resto dopo la prima parola è la sigla delle iniziali
export function abbreviazione(a, b) {
  const x = norm(a).split(' '), y = norm(b).split(' ');
  if (!x.length || !y.length || x[0] !== y[0] || x.length === y.length && x.every((w, i) => w === y[i])) return false;
  const [corto, lungo] = x.length < y.length ? [x, y] : [y, x];
  const tail = corto.slice(1).join(''), parti = lungo.slice(1);
  return tail.length > 0 && (tail === sigla(parti) || tail === parti.join('') || (corto.length === 2 && sigla(parti).startsWith(tail) && tail.length >= 2));
}
function distanza(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
export function somiglianza(a, b) {
  const x = norm(a), y = norm(b); if (!x || !y) return 0;
  if (x === y) return 1;
  if (abbreviazione(a, b)) return 0.92;
  if (y.startsWith(x) || x.startsWith(y)) return 0.85;
  return 1 - distanza(x, y) / Math.max(x.length, y.length);
}

let cache = { t: 0, righe: null };
export const svuotaCache = () => { cache = { t: 0, righe: null }; };
export async function elenco(db) {
  if (cache.righe && Date.now() - cache.t < 60_000) return cache.righe;
  const { rows } = await db.query(`select c.id, c.nome, c.regione, c.provincia, c.alias,
      coalesce((select array_agg(u.nome order by u.nome) from unita_territoriale u where u.comitato_id = c.id), '{}') as unita from comitato c order by c.nome`);
  cache = { t: Date.now(), righe: rows }; return rows;
}
// restituisce il comitato ufficiale se il testo coincide (nome, alias, sigla); altrimenti null
export async function trova(db, testo) {
  const n = norm(testo); if (!n) return null;
  const tutti = await elenco(db);
  return tutti.find((c) => norm(c.nome) === n || c.alias.some((a) => norm(a) === n))
    ?? tutti.find((c) => abbreviazione(c.nome, testo)) ?? null;
}
// nome da salvare: quello ufficiale se riconosciuto, altrimenti il testo com'è
export async function canonico(db, testo) {
  const t = String(testo ?? '').trim(); if (!t) return { nome: null, comitato: null };
  const c = await trova(db, t); return { nome: c ? c.nome : t, comitato: c };
}
