// Controllo formale del codice fiscale italiano (16 caratteri): struttura, carattere di controllo e
// coerenza con cognome e nome. Non prova che il codice appartenga a chi lo scrive: nessun controllo gratuito può farlo.
const DISPARI = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };
const OMOCODIA = 'LMNPQRSTUV';          // lettere che sostituiscono le cifre 0-9 nei casi di omocodia
const VOCALI = 'AEIOU';

const lettere = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
const cons = (s) => [...lettere(s)].filter((c) => !VOCALI.includes(c));
const voc = (s) => [...lettere(s)].filter((c) => VOCALI.includes(c));
const tre = (a) => (a.join('') + 'XXX').slice(0, 3);
export const codiceCognome = (c) => tre([...cons(c), ...voc(c)]);
export const codiceNome = (n) => { const k = cons(n); return tre(k.length >= 4 ? [k[0], k[2], k[3]] : [...k, ...voc(n)]); };

export function carattereControllo(cf15) {
  let somma = 0;
  [...cf15].forEach((c, i) => { somma += i % 2 === 0 ? DISPARI[c] : (/\d/.test(c) ? Number(c) : c.charCodeAt(0) - 65); });
  return String.fromCharCode(65 + (somma % 26));
}

// { ok, errore?, coerente, normalizzato }: ok = struttura e carattere di controllo; coerente = cognome e nome corrispondono
export function verificaCodiceFiscale(cf, cognome, nome) {
  const c = String(cf || '').replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(c)) return { ok: false, errore: 'codice fiscale non valido: controlla le 16 lettere e cifre', normalizzato: c };
  if (carattereControllo(c.slice(0, 15)) !== c[15]) return { ok: false, errore: 'codice fiscale non valido: l\'ultima lettera non torna, controlla di averlo scritto bene', normalizzato: c };
  const coerente = c.slice(0, 3) === codiceCognome(cognome) && c.slice(3, 6) === codiceNome(nome);
  return { ok: true, coerente, normalizzato: c };
}
