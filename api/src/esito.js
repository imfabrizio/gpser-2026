// Giudizio ed esito di una scheda: con le fasce della scheda "superato" = raggiunta la fascia Sufficiente; altrimenti vale la soglia % dell'evento.
export function valutaEsito({ punti, massimo, fasce, soglia }) {
  const perc = massimo ? punti / massimo * 100 : 0;
  const f = Array.isArray(fasce) && fasce.length ? [...fasce].sort((a, b) => a.da - b.da) : null;
  if (f) {
    const suff = f.find((x) => /^sufficiente/i.test(x.nome)) || f[1] || f[0];
    const giudizio = [...f].reverse().find((x) => punti >= x.da)?.nome ?? f[0].nome;
    return { perc, giudizio, sogliaPunti: suff.da, superato: punti >= suff.da };
  }
  return { perc, giudizio: null, sogliaPunti: null, superato: soglia ? perc >= soglia : null };
}
