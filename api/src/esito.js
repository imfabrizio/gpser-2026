// Giudizio ed esito di una scheda: con le fasce della scheda "superato" = raggiunta la fascia Sufficiente; altrimenti vale la soglia % dell'evento.
// Fasce automatiche per una skill con n voci da 0-1-2 (massimo = 2n): Sufficiente dal 75%, Discreto dall'80%, Buono dall'85%, Ottimo dal 95%.
// Ogni soglia è "maggiore o uguale" e si arrotonda per eccesso. Sufficiente resta ancorata al 75%; Sufficiente, Discreto e Buono devono avere
// almeno due punteggi: se le fasce sono troppo strette si spostano verso l'alto le soglie successive (l'Ottimo può restare al solo massimo).
export function fasceAuto(nVoci) {
  const max = 2 * nVoci;
  if (!(max > 0)) return null;
  const c = (p) => Math.ceil(Math.round(max * p * 1000) / 100000);
  const suff = c(75);
  const disc = Math.min(Math.max(c(80), suff + 2), max);
  const buono = Math.min(Math.max(c(85), disc + 2), max);
  const ottimo = Math.min(Math.max(c(95), buono + 1), max);
  return [{ da: 0, nome: 'Insufficiente' }, { da: suff, nome: 'Sufficiente' }, { da: disc, nome: 'Discreto' }, { da: buono, nome: 'Buono' }, { da: ottimo, nome: 'Ottimo' }];
}

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
