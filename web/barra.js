// Barra in alto: scelta dell'area (Gare e Olimpiadi, Formazione, Gestione comune) e campanella delle notifiche.
(() => {
  const leggi = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stile = document.createElement('style');
  stile.textContent = `#aree{border:1.5px solid #8C94A3;border-radius:999px;padding:7px 12px;font:inherit;font-size:14px;font-weight:700;background:#fff;color:inherit;max-width:190px}
  #campana{position:relative;padding:8px 12px!important;line-height:1}#campana .nb{position:absolute;top:-6px;right:-4px;background:#C62828;color:#fff;border-radius:999px;font-size:12px;min-width:20px;padding:1px 5px;font-weight:700}
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
  let sede = 'index', timer = null;
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
  window.Barra = {
    disegna(dove, corrente) {
      sede = dove || sede; const me = leggi('me'), h = document.querySelector('header'); if (!h || !me || !localStorage.getItem('token') || me.in_attesa) { document.getElementById('aree')?.remove(); document.getElementById('campana')?.remove(); return; }
      const lista = aree(me);
      let s = document.getElementById('aree');
      if (lista.length > 1) {
        if (!s) { s = document.createElement('select'); s.id = 'aree'; s.title = 'Cambia area'; s.setAttribute('aria-label', 'Area'); const h1 = h.querySelector('h1'); (h1 || h.firstChild).after(s);
          s.onchange = () => { const v = s.value; if (v === 'comune') { location.href = '/admin.html#hub:comune'; return; }
            if (sede === 'admin') { location.hash = '#hub:' + (v === 'formazione' ? 'corsi' : 'gara'); return; }
            localStorage.setItem('mondo', v); if (location.pathname === '/' && !location.hash) location.reload(); else location.href = '/'; }; }
        s.innerHTML = lista.map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
        const att = corrente || (sede === 'admin' ? (window.fam === 'corsi' ? 'formazione' : window.fam) : (localStorage.getItem('mondo') || 'gara')); s.value = lista.some(([k]) => k === att) ? att : lista[0][0];
      } else if (s) s.remove();
      if (!document.getElementById('campana')) { const b = document.createElement('button'); b.id = 'campana'; b.title = 'Notifiche'; b.setAttribute('aria-label', 'Notifiche');
        b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
        b.onclick = apri; const ref = document.getElementById('chi') || document.getElementById('hsic'); (ref || h.lastElementChild).before(b); }
      conta(); if (!timer) timer = setInterval(conta, 60000);
    },
  };
})();
