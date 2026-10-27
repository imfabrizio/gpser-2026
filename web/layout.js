// Barre laterali delle pagine di valutazione: menu a sinistra e riepilogo a destra (non nel monitor, nella classifica e nella scheda di valutazione, che hanno bisogno di tutta la larghezza).
(() => {
  const leggi = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dataIt = (d) => (d ? String(d).split('-').reverse().join('/') : '');
  const st = document.createElement('style');
  st.textContent = `#lat,#rail{display:none}
  @media (min-width:900px){ body.laterale #lat{display:flex;flex-direction:column;gap:2px;position:fixed;left:0;top:85px;bottom:0;width:210px;overflow-y:auto;background:#fff;border-right:1px solid #d9dce3;padding:10px 8px;z-index:3}
    
    body.laterale main{margin:0 0 0 210px;max-width:none} body.laterale main > *{max-width:900px;margin-left:auto;margin-right:auto} }
  @media (min-width:1100px){ body.laterale main{margin-right:210px} body.laterale #rail{display:block;position:fixed;right:0;top:85px;bottom:0;width:210px;overflow-y:auto;border-left:1px solid #d9dce3;background:#fff;padding:14px 12px;z-index:3} }
  #lat .w,#rail .w{background:#f6f7f9;border-radius:12px;padding:12px;margin-bottom:12px;font-size:14px} #lat .w h4,#rail .w h4{margin:0 0 6px;font-size:13px;color:#555;font-weight:600} #lat .w b.n,#rail .w b.n{display:block;font-size:18px;line-height:1.2;margin-bottom:4px}
  #lat .w small,#rail .w small{color:#555;display:block} #lat .w a,#rail .w a{display:block;padding:7px 0;color:var(--rosso,#C8102E);font-weight:600;text-decoration:none} #rail .logo-r{display:block;margin:4px auto 14px;width:84px;opacity:.9} #lat .av,#rail .av{padding:6px 0;border-top:1px solid #e3e5ea} #lat .av:first-of-type,#rail .av:first-of-type{border-top:0}`;
  document.head.append(st);
  const lat = document.createElement('nav'); lat.id = 'lat'; lat.setAttribute('aria-label', 'Menu');
  const rail = document.createElement('aside'); rail.id = 'rail'; rail.setAttribute('aria-label', 'Riepilogo');
  document.body.append(lat, rail);
  const api = async (p) => { const r = await fetch('/api' + p, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } }); if (!r.ok) throw new Error(r.status); return r.json(); };
  let giro = 0;
  window.Layout = {
    async disegna() {
      const me = leggi('me'), v = location.hash.slice(1).split('/')[0], mio = ++giro;
      const senza = !me || !localStorage.getItem('token') || me.in_attesa || me.mfa_da_configurare || ['monitor', 'valuta', 'classifica'].includes(v);
      document.body.classList.toggle('laterale', !senza);
      { const h = document.getElementById('hhome'); if (h && document.getElementById('homeb')) h.hidden = true; }
      if (senza) { lat.innerHTML = ''; rail.innerHTML = ''; return; }
      const part = me.ruolo === 'partecipante';
      // a sinistra la sezione in cui sei e gli strumenti (gara attiva, notifiche), a destra gli avvisi
      const sez = window.Barra ? Barra.sezione() : null;
      lat.innerHTML = (sez ? Barra.banda(sez) : '') + '<div class="w" id="r_ev"><h4>Gara attiva</h4><small>Carico…</small></div><div class="w" id="r_nt" hidden><h4>Notifiche</h4></div>';
      rail.innerHTML = '<img class="logo-r" src="/logo-cri.jpg" alt=""><div class="w" id="r_av" hidden><h4>Avvisi</h4></div>';
      if (!part) try {
        const evs = await api('/eventi'); if (mio !== giro) return; const e = evs.find((x) => x.attivo);
        $r('r_ev').innerHTML = e ? `<h4>Gara attiva</h4><b class="n">${esc(e.nome)}</b><small>${esc([dataIt(e.data), e.luogo].filter(Boolean).join(' · ') || 'data e luogo da indicare')}</small>` : '<h4>Gara attiva</h4><small>Nessuna gara attiva</small>';
      } catch { $r('r_ev')?.remove(); } else $r('r_ev')?.remove();
      try {
        const n = await api('/me/notifiche'); if (mio !== giro) return; const nl = (n.elenco || []).filter((x) => !x.letta).slice(0, 3);
        if (nl.length) { $r('r_nt').hidden = false; $r('r_nt').insertAdjacentHTML('beforeend', nl.map((x) => `<div class="av"><b>${esc(x.titolo)}</b></div>`).join('')); }
      } catch { /* niente */ }
      try {
        const av = await api('/avvisi'); if (mio !== giro || !av.length) return;
        $r('r_av').hidden = false; $r('r_av').insertAdjacentHTML('beforeend', av.slice(0, 3).map((a) => `<div class="av"><b>${esc(a.titolo)}</b><small>${esc((a.testo || '').slice(0, 90))}</small></div>`).join(''));
      } catch { /* niente */ }
    },
  };
  const $r = (id) => document.getElementById(id);
})();
