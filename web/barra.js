// Barra in alto: scelta dell'area (Gare e Olimpiadi, Formazione, Gestione comune) e campanella delle notifiche.
(() => {
  const leggi = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stile = document.createElement('style');
  stile.textContent = `#aree{border:1.5px solid #8C94A3;border-radius:999px;padding:7px 12px;font:inherit;font-size:14px;font-weight:700;background:#fff;color:inherit;max-width:190px}
  #lay{padding:8px 12px!important;line-height:1}#campana{position:relative;padding:8px 12px!important;line-height:1}#campana .nb{position:absolute;top:-6px;right:-4px;background:#C62828;color:#fff;border-radius:999px;font-size:12px;min-width:20px;padding:1px 5px;font-weight:700}
  .banda{display:flex;gap:10px;align-items:center;border-radius:12px;padding:14px 12px;margin-bottom:12px;color:#fff;white-space:normal;text-align:left}.banda svg{flex:none;width:30px;height:30px}.banda b{display:block;font-size:17px;line-height:1.15;color:#fff}.banda small{display:block;font-size:12px;color:#fff;margin-top:2px}
  #dlgn{border:0;border-radius:14px;max-width:460px;width:92vw;padding:0;box-shadow:0 12px 40px #0004}#dlgn .nt{padding:12px 16px;border-bottom:1px solid #e3e5ea;cursor:pointer}#dlgn .nt.nl{background:#fff4f4}#dlgn .nt small{color:#666;display:block}`;
  document.head.append(stile);
  const aree = (me) => {
    const a = me.aree || [], org = ['admin', 'organizzazione'].includes(me.ruolo);
    if (!org) return [];
    const out = [];
    if (me.admin || me.ruolo === 'admin' || a.some((x) => !['esami', 'formazione_esame', 'valutazione', 'anagrafiche'].includes(x))) out.push(['gara', 'Gare e Olimpiadi']);
    if (me.admin || me.ruolo === 'admin' || a.some((x) => ['esami', 'formazione_esame'].includes(x))) out.push(['formazione', 'Formazione']);
    if (me.admin || me.ruolo === 'admin' || a.includes('anagrafiche')) out.push(['comune', 'Gestione comune']);
    return out;
  };
  const api = async (p, body) => { const t = localStorage.getItem('token'); const r = await fetch('/api' + p, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + t }, body: body ? JSON.stringify(body) : undefined }); if (!r.ok) throw new Error(r.status); return r.json(); };
  // nome breve del programma e banda colorata che dice in che sezione sei
  const MARCHIO = 'CRI Eventi';
  const SEZ = {
    gara: ['Gare e Olimpiadi', '#C8102E', 'Gare, allenamenti, scene e classifiche', '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'],
    formazione: ['Formazione', '#1F5F8B', 'Corsi, Mega Code ed esami', '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/>'],
    comune: ['Gestione comune', '#4A5260', 'Anagrafiche, utenti e ruoli', '<path d="M4 21V7l8-4 8 4v14M9 21v-6h6v6M9 10h1M14 10h1"/>'],
  };
  let sede = 'index', timer = null;
  // «Home» riporta alla pagina d'ingresso con le tre aree: si dimentica l'area scelta
  document.addEventListener('click', (e) => { if (e.target.closest('a[href="/"], a[href="/#"], a.home, #hhome, #homeb')) { try { localStorage.removeItem('mondo'); } catch { /* niente */ } } }, true);
  async function conta() {
    const b = document.getElementById('campana'); if (!b) return;
    try { const d = await api('/me/notifiche'); const n = d.non_lette; let nb = b.querySelector('.nb'); if (n && !nb) { nb = document.createElement('span'); nb.className = 'nb'; b.append(nb); } if (nb) { if (n) nb.textContent = n; else nb.remove(); } window.__notifiche = d.elenco; } catch { /* offline */ }
  }
  async function apri() {
    let d; try { d = await api('/me/notifiche'); } catch { return; }
    let dlg = document.getElementById('dlgn'); if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'dlgn'; document.body.append(dlg); dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); }
    dlg.innerHTML = `<div style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center"><strong>Notifiche</strong><span><button id="nt_tutte" style="font-size:13px;padding:5px 10px">Segna tutte come lette</button> <button id="nt_x" style="font-size:13px;padding:5px 10px">Chiudi</button></span></div>
      ${d.elenco.length ? d.elenco.map((n) => `<div class="nt ${n.letta ? '' : 'nl'}" data-id="${n.id}" data-l="${esc(n.link || '')}"><b>${esc(n.titolo)}</b>${n.testo ? `<small>${esc(n.testo)}</small>` : ''}<small>${esc(String(n.created_at).slice(0, 10))}</small></div>`).join('') : '<p style="padding:16px;color:#666">Nessuna notifica.</p>'}`;
    dlg.showModal();
    document.getElementById('nt_x').onclick = () => dlg.close();
    document.getElementById('nt_tutte').onclick = async () => { await api('/me/notifiche/lette', {}); dlg.close(); conta(); };
    dlg.querySelectorAll('.nt').forEach((el) => { el.onclick = async () => { await api('/me/notifiche/lette', { id: el.dataset.id }).catch(() => {}); dlg.close(); conta(); if (el.dataset.l) { if (el.dataset.l.startsWith('/admin.html#') && location.pathname === '/admin.html') location.hash = el.dataset.l.split('#')[1]; else location.href = el.dataset.l; } }; });
  }
  const flashLay = (t) => { const d = document.createElement('div'); d.textContent = 'Layout: ' + t; d.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1b1f27;color:#fff;padding:10px 16px;border-radius:999px;z-index:99;font:600 14px sans-serif'; document.body.append(d); setTimeout(() => d.remove(), 2000); };
  window.Barra = {
    marchio: MARCHIO,
    colore: (k) => (SEZ[k] ? SEZ[k][1] : '#C8102E'),
    nomeSezione: (k) => (SEZ[k] ? SEZ[k][0] : ''),
    // titolo da mettere in alto: «CRI Eventi · Formazione»
    titolo: (k) => MARCHIO + (SEZ[k] ? ' · ' + SEZ[k][0] : ''),
    banda(k) { const z = SEZ[k]; return z ? `<div class="banda" style="background:${z[1]}" role="note" aria-label="Sezione: ${z[0]}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${z[3]}</svg><span><b>${z[0]}</b><small>${z[2]}</small></span></div>` : ''; },
    // sezione in cui si trova l'utente (solo per chi ha accesso alle aree dell'organizzazione)
    sezione(corrente) { const me = leggi('me'); if (!me) return null; const l = aree(me); if (!l.length) return null; const att = corrente || localStorage.getItem('mondo') || 'gara'; return l.some(([k]) => k === att) ? att : l[0][0]; },
    disegna(dove, corrente) {
      sede = dove || sede; const me = leggi('me'), h = document.querySelector('header'); if (!h || !me || !localStorage.getItem('token') || me.in_attesa) { document.getElementById('aree')?.remove(); document.getElementById('campana')?.remove(); return; }
      const lista = aree(me);
      let s = document.getElementById('aree');
      // icona Home sempre presente, in ogni pagina, accanto al logo
      if (!h.querySelector('a.home') && !document.getElementById('homeb')) { const a = document.createElement('a'); a.id = 'homeb'; a.className = 'home'; a.href = '/'; a.title = 'Home'; a.setAttribute('aria-label', 'Home'); a.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg>'; (h.querySelector('img') || h.firstChild).after(a); }
      document.getElementById('hhome')?.setAttribute('hidden', '');
      if (lista.length > 1) {
        if (!s) { s = document.createElement('select'); s.id = 'aree'; s.title = 'Cambia area'; s.setAttribute('aria-label', 'Area'); const h1 = h.querySelector('h1'); (h.querySelector('a.home') || h1 || h.firstChild).after(s);
          s.onchange = () => { const v = s.value; if (v === 'comune') { location.href = '/admin.html#hub:comune'; return; }
            if (sede === 'admin') { location.hash = '#hub:' + (v === 'formazione' ? 'corsi' : 'gara'); return; }
            localStorage.setItem('mondo', v); if (location.pathname === '/' && !location.hash) location.reload(); else location.href = '/'; }; }
        s.innerHTML = lista.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
        const att = corrente || (sede === 'admin' ? (window.fam === 'corsi' ? 'formazione' : window.fam) : (localStorage.getItem('mondo') || 'gara')); s.value = lista.some(([k]) => k === att) ? att : lista[0][0];
      } else if (s) s.remove();
      if (!document.getElementById('campana')) { const b = document.createElement('button'); b.id = 'campana'; b.title = 'Notifiche'; b.setAttribute('aria-label', 'Notifiche');
        b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
        b.onclick = apri; const ref = document.getElementById('chi') || document.getElementById('hsic'); (ref || h.lastElementChild).before(b); }
      if (window.Layout2 && !document.getElementById('lay')) { const l = document.createElement('button'); l.id = 'lay'; l.type = 'button';
        const ico = (m) => (m === 'tel' ? '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>' : m === 'pc' ? '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>' : '<rect x="3" y="5" width="12" height="9" rx="1.5"/><rect x="13" y="9" width="8" height="12" rx="1.5"/>');
        const agg = () => { const m = Layout2.modo(); l.title = 'Layout: ' + Layout2.nome(m) + ' (tocca per cambiare)'; l.setAttribute('aria-label', l.title); l.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico(m)}</svg>`; };
        agg(); l.onclick = () => { Layout2.giro(); agg(); flashLay(Layout2.nome(Layout2.modo())); }; document.getElementById('campana').before(l); }
      conta(); if (!timer) timer = setInterval(conta, 60000);
    },
  };
})();
