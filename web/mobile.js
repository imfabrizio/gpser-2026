// Layout per telefono: automatico sotto i 700 px di larghezza, oppure scelto a mano («Telefono» / «Tablet e computer»).
(() => {
  const leggi = () => { try { return localStorage.getItem('layout') || 'auto'; } catch { return 'auto'; } };
  const applica = () => { const s = leggi(); const tel = s === 'tel' || (s === 'auto' && window.innerWidth <= 700); document.documentElement.classList.toggle('tel', tel); document.documentElement.classList.toggle('pc', s === 'pc'); };
  applica(); window.addEventListener('resize', applica);
  window.Layout2 = {
    modo: leggi,
    imposta(m) { try { localStorage.setItem('layout', m); } catch { /* niente */ } applica(); document.dispatchEvent(new Event('layout-cambiato')); },
    // pulsante nella barra in alto: Automatico → Telefono → Tablet e computer
    giro() { const o = ['auto', 'tel', 'pc']; this.imposta(o[(o.indexOf(leggi()) + 1) % 3]); },
    nome: (m) => ({ auto: 'Automatico (in base alla larghezza)', tel: 'Telefono', pc: 'Tablet e computer' })[m],
  };
})();
