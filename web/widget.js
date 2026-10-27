// Widget della Home: ognuno sceglie quali vedere e in che ordine dall'area utente (account); i contatti preferiti sono suoi.
(() => {
  const leggi = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dataIt = (d) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
  const oggi = () => new Date().toISOString().slice(0, 10);
  const org = (me) => ['admin', 'organizzazione'].includes(me.ruolo);
  const CAT = [
    ['valutazioni', 'Le mie valutazioni', 'Le schede che ti sono assegnate, con il tasto per iniziare', (me) => org(me) || (me.aree || []).includes('valutazione')],
    ['storico', 'I miei esiti', 'Le valutazioni dei tuoi Mega Code ed esami, quando il docente le pubblica', () => true],
    ['eventi', 'Prossimi eventi', 'Gare, corsi ed esami in arrivo', () => true],
    ['gara_attiva', 'Gara o corso attivo', 'Quello in corso adesso, con data e luogo', () => true],
    ['news', 'Novità e avvisi', 'Le comunicazioni pubblicate dall\'organizzazione', () => true],
    ['notifiche', 'Notifiche da leggere', 'Le ultime notifiche non lette', () => true],
    ['contatti', 'Contatti preferiti', 'Numeri ed email che ti servono, scelti da te', () => true],
    ['approvare', 'Richieste da approvare', 'Accessi in attesa di approvazione', (me) => me.ruolo === 'admin'],
  ];
  const disponibili = (me) => CAT.filter((c) => c[3](me));
  const predefiniti = (me) => disponibili(me).map((c) => c[0]).filter((k) => ['eventi', 'news'].includes(k) || ((k === 'valutazioni' || k === 'storico') && !org(me)));
  const scelti = (me) => { const w = me?.preferenze?.widget; const ok = disponibili(me).map((c) => c[0]); return (Array.isArray(w) ? w : predefiniti(me)).filter((k) => ok.includes(k)); };
  const stile = document.createElement('style');
  stile.textContent = `.widgets{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin:0 0 10px}
  .wd{background:#fff;border:1px solid #d9dce3;border-radius:10px;padding:14px;min-width:0}.wd h4{margin:0 0 8px;font-size:15px}.wd .r{padding:7px 0;border-top:1px solid #eceef2}.wd .r:first-of-type{border-top:0}.wd .r small{display:block;color:#555}
  .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;font-size:13px;margin:6px 0}.cal i{font-style:normal;color:#666;font-size:11px}.cal span{padding:5px 0;border-radius:6px}.cal .gg{border:0;font:inherit;cursor:pointer;padding:5px 0;width:auto;min-width:0;border-radius:6px}.cal .sl{box-shadow:0 0 0 2px #222}.gd{border-top:1px solid #d9dce3;margin-top:6px;padding-top:6px}.cal .ev{background:var(--rosso,#C8102E);color:#fff;font-weight:700}.cal .og{outline:2px solid #1F5F8B}
  #rail .widgets{display:block;margin:0}#rail .wd{margin-bottom:12px;padding:12px;font-size:14px;background:#f6f7f9;border:0;border-radius:12px}#rail .wd h4{font-size:13px;color:#555}
  .widgets .wl{grid-column:1/-1;font-size:13px;display:block;margin:2px 0 8px}
  @media (min-width:1100px){body.laterale .solo-stretto{display:none}}
  #tabs .calw .cal,#lat .calw .cal{font-size:12px}.cn button{width:auto!important;min-width:0;padding:4px 10px!important}.cn h4{margin:0}
  a.vl{display:inline-block;margin-top:4px;padding:5px 10px;border-radius:8px;background:var(--rosso,#C8102E);color:#fff!important;font-weight:700;font-size:12px;text-decoration:none}a.vl.sec{background:#fff;color:#222!important;border:1px solid #8C94A3}.calw .cn h4{font-size:13px;text-transform:capitalize}.calw .esp{width:100%;margin-top:6px;font-size:13px;padding:6px}
  #dlgcal{border:0;border-radius:14px;max-width:560px;width:94vw;padding:16px 18px;box-shadow:0 12px 40px #0004}#dlgcal .cal{font-size:16px;gap:4px}#dlgcal .cal span{padding:10px 0}#dlgcal .cn h4{font-size:18px;text-transform:capitalize}
  .cn{display:flex;justify-content:space-between;align-items:center}.cn button{padding:4px 10px}
  .wed .rg{display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid #eceef2}.wed .rg input[type=checkbox]{width:22px!important;height:22px;flex:none;margin:0;padding:0}.wed .rg label{margin:0;flex:1;min-width:0;display:block;text-align:left}.wed .rg small{display:block;color:#555}.wed .rg button{padding:3px 9px;width:auto;flex:none;min-width:0}
  .wed .ct{display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin:6px 0}@media (max-width:600px){.wed .ct{grid-template-columns:1fr}}`;
  stile.textContent += `
  .calw,#dlgcal{--sez:#C8102E}
  .cn{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.cn h4{margin:0;font-size:15px;font-weight:700;text-transform:capitalize}.cn .fr{display:flex;gap:4px}
  .cn button{width:28px!important;height:28px;padding:0!important;border-radius:50%;border:1px solid #d3d7de;background:#fff;color:#333;font-size:16px;line-height:1;cursor:pointer;display:grid;place-items:center}.cn button:hover{background:#eef0f3}
  .cal{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin:0 0 6px;text-align:center}
  .cal i{font-style:normal;font-size:11px;color:#6b7280;padding:2px 0}
  .cal span,.cal .gg{aspect-ratio:1;display:grid;place-items:center;font-size:13px;line-height:1;border-radius:9px;padding:0;color:#2b2f36}
  .cal .gg{border:0;background:var(--sez);color:#fff;font-weight:700;cursor:pointer;transition:transform .08s}.cal .gg:hover{transform:scale(1.08)}
  .cal .og{box-shadow:inset 0 0 0 2px #1F2937;font-weight:700}.cal .gg.og{box-shadow:inset 0 0 0 2px #fff,0 0 0 2px #1F2937}
  .cal .gg.sl{box-shadow:0 0 0 3px #fff,0 0 0 5px var(--sez)}
  .gd{margin-top:8px;border-top:0;padding-top:0}.gd>small{display:block;color:#555;margin-bottom:4px}
  .gd .r{border-top:0;border-left:3px solid var(--sez);padding:4px 8px;margin-bottom:5px;background:#fff;border-radius:0 8px 8px 0}
  .calw .esp{width:100%;margin-top:8px;font-size:13px;padding:7px;background:#fff;border:1px solid #d3d7de;border-radius:8px;cursor:pointer}.calw .esp:hover{background:#eef0f3}
  #dlgcal{max-width:520px}#dlgcal .cal{gap:6px}#dlgcal .cal span,#dlgcal .cal .gg{font-size:17px;border-radius:12px}#dlgcal .cn h4{font-size:20px}#dlgcal .cn button{width:36px!important;height:36px;font-size:20px}`;
  document.head.append(stile);
  const api = async (p, o = {}) => { const r = await fetch('/api' + p, { method: o.method || 'GET', headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), ...(o.body ? { 'Content-Type': 'application/json' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); if (!r.ok) throw new Error(r.status); return r.json(); };
  const TIPO = { gara: 'Gara', olimpiadi: 'Olimpiadi', allenamento: 'Allenamento', corso: 'Corso', megacode: 'Mega Code', esame: 'Esame' };
  const TIPI = { formazione: ['corso', 'megacode', 'esame'], gara: ['gara', 'olimpiadi', 'allenamento'] };
  const riga = (e) => `<div class="r"><b>${esc(e.nome)}</b><small>${esc(TIPO[e.tipo] || '')}${e.luogo ? ' · ' + esc(e.luogo) : ''}${e.data ? ' · ' + dataIt(e.data) + (e.data_fine && e.data_fine !== e.data ? '–' + dataIt(e.data_fine) : '') : ''}</small></div>`;
  const giorni = (e) => { const a = String(e.data || '').slice(0, 10), b = String(e.data_fine || e.data || '').slice(0, 10); return [a, b]; };

  const COSTRUTTORI = {
    async eventi(box, c) {
      const l = c.eventi.filter((e) => !e.archiviato && !(e.tipo === 'megacode' && e.corso_id) && (!c.mondo || TIPI[c.mondo].includes(e.tipo)) && (e.attivo || !e.data || (e.data_fine || e.data) >= oggi())).sort((a, b) => String(a.data || '9999').localeCompare(String(b.data || '9999'))).slice(0, 5);
      const chiave = c.mondo === 'formazione' ? 'evF' : 'ev';
      box.innerHTML = `<h4>Prossimi eventi</h4>${l.length ? l.map((e) => `<div class="r">${riga(e).replace(/^<div class="r">|<\/div>$/g, '')}${org(c.me) && e.tipo !== 'esame' && e.tipo !== 'allenamento' && (c.mondo === 'formazione') === TIPI.formazione.includes(e.tipo) ? `<a class="vl" href="#valutazione" data-ev="${e.id}" data-k="${chiave}">Inizia le valutazioni</a>` : ''}</div>`).join('') : '<small>Nessun evento in programma.</small>'}`;
      box.querySelectorAll('[data-ev]').forEach((a) => { a.onclick = () => { try { localStorage.setItem(a.dataset.k, a.dataset.ev); } catch { /* niente */ } }; });
    },
    async gara_attiva(box, c) {
      const e = c.eventi.find((x) => x.attivo && (!c.mondo || TIPI[c.mondo].includes(x.tipo))) || c.eventi.find((x) => x.attivo);
      box.innerHTML = `<h4>${c.mondo === 'formazione' ? 'Evento attivo' : 'Gara attiva'}</h4>${e ? riga(e).replace(/^<div class="r">|<\/div>$/g, '') : '<small>Nessun evento attivo.</small>'}`;
    },
    async storico(box) {
      let r = []; try { r = (await api('/me/storico')).righe; } catch { /* nessuno storico */ }
      box.innerHTML = `<h4>I miei esiti</h4>${r.length ? r.slice(-3).reverse().map((x) => `<div class="r"><b>${esc(x.scheda)}</b> · ${x.punti}/${x.massimo} (${x.perc}%)<small>${esc(x.evento)}${x.giudizio ? ' · ' + esc(x.giudizio) : ''}</small></div>`).join('') + '<a class="vl" href="/#storico">Tutto lo storico</a>' : '<small>Quando un docente pubblica gli esiti dei tuoi Mega Code li trovi qui.</small>'}`;
    },
    async valutazioni(box, c) {
      const e = c.eventi.find((x) => x.attivo && (!c.mondo || TIPI[c.mondo].includes(x.tipo))) || c.eventi.find((x) => x.attivo);
      if (!e) { box.innerHTML = '<h4>Le mie valutazioni</h4><small>Nessun evento attivo.</small>'; return; }
      const sc = (await api(`/eventi/${e.id}/scene`)).filter((s) => s.schede && s.schede.length);
      const n = sc.reduce((t, s) => t + s.schede.length, 0);
      box.innerHTML = `<h4>Le mie valutazioni</h4><small>${esc(e.nome)}</small>${n ? sc.slice(0, 4).map((s) => `<div class="r"><b>Scena ${esc(s.codice)}</b> ${esc(s.titolo || '')}<small>${s.schede.map((k) => esc(k.titolo)).join(' · ')}</small></div>`).join('') + (sc.length > 4 ? `<small>e altre ${sc.length - 4} scene</small>` : '') : '<div class="r"><small>Nessuna scheda assegnata.</small></div>'}
        ${n ? `<a class="vl" href="#valutazione" id="wv_${e.id}">Inizia le valutazioni</a>` : ''}`;
      const a = box.querySelector('a.vl'); if (a) a.onclick = () => { try { localStorage.setItem(c.mondo === 'formazione' ? 'evF' : 'ev', e.id); } catch { /* niente */ } };
    },
    async calendario(box, c, grande) {
      let m = new Date(); m = new Date(m.getFullYear(), m.getMonth(), 1); let sel = null;
      const disegna = () => {
        const y = m.getFullYear(), mm = m.getMonth(), n = new Date(y, mm + 1, 0).getDate(), primo = (m.getDay() + 6) % 7, iso = (d) => `${y}-${String(mm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const delGiorno = (d) => c.eventi.filter((e) => { const [a, b] = giorni(e); return a && a <= iso(d) && b >= iso(d); });
        let cel = ['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((x) => `<i>${x}</i>`).join('') + '<span></span>'.repeat(primo);
        for (let d = 1; d <= n; d++) { const ha = delGiorno(d).length > 0; cel += ha ? `<button type="button" class="gg ev ${iso(d) === oggi() ? 'og' : ''} ${sel === iso(d) ? 'sl' : ''}" data-g="${iso(d)}" aria-label="${d}: ${delGiorno(d).length} attività">${d}</button>` : `<span class="${iso(d) === oggi() ? 'og' : ''}">${d}</span>`; }
        const dett = sel && sel.startsWith(iso(1).slice(0, 8)) ? delGiorno(Number(sel.slice(8))) : [];
        box.innerHTML = `<div class="cn"><h4>${m.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}</h4><span class="fr"><button type="button" data-d="-1" aria-label="Mese precedente">‹</button><button type="button" data-d="1" aria-label="Mese successivo">›</button></span></div><div class="cal">${cel}</div>
          ${dett.length ? `<div class="gd"><small><b>${dataIt(sel)}</b></small>${dett.map((e) => riga(e)).join('')}</div>` : ''}${grande ? '' : '<button type="button" class="sec esp">Ingrandisci</button>'}`;
        box.querySelectorAll('[data-d]').forEach((b) => { b.onclick = () => { m = new Date(m.getFullYear(), m.getMonth() + Number(b.dataset.d), 1); sel = null; disegna(); }; });
        box.querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => { sel = sel === b.dataset.g ? null : b.dataset.g; disegna(); }; });
        const x = box.querySelector('.esp'); if (x) x.onclick = () => apriGrande(c);
      };
      disegna();
    },
    async news(box, c) {
      const l = (await api('/avvisi?ambito=' + (c.mondo === 'formazione' ? 'formazione' : 'gare'))).slice(0, 4);
      box.innerHTML = `<h4>Novità e avvisi</h4>${l.length ? l.map((a) => `<div class="r"><b>${esc(a.titolo)}</b>${a.testo ? `<small>${esc(a.testo.slice(0, 160))}</small>` : ''}<small>${esc(String(a.created_at).slice(0, 10).split('-').reverse().join('/'))}</small></div>`).join('') : '<small>Nessuna novità.</small>'}`;
    },
    async notifiche(box) {
      const d = await api('/me/notifiche'), l = (d.elenco || []).filter((x) => !x.letta).slice(0, 4);
      box.innerHTML = `<h4>Notifiche da leggere</h4>${l.length ? l.map((x) => `<div class="r"><b>${esc(x.titolo)}</b>${x.testo ? `<small>${esc(x.testo.slice(0, 120))}</small>` : ''}</div>`).join('') + '<a href="#" class="vl sec" id="w_apri">Apri le notifiche</a>' : '<small>Nessuna notifica da leggere.</small>'}`;
      const a = box.querySelector('#w_apri'); if (a) a.onclick = (e) => { e.preventDefault(); document.getElementById('campana')?.click(); };
    },
    async contatti(box, c) {
      const l = c.me.preferenze?.contatti || [];
      box.innerHTML = `<h4>Contatti preferiti</h4>${l.length ? l.map((x) => `<div class="r"><b>${esc(x.nome)}</b><small>${x.tel ? `<a href="tel:${esc(x.tel.replace(/\s/g, ''))}">${esc(x.tel)}</a>` : ''}${x.tel && x.email ? ' · ' : ''}${x.email ? `<a href="mailto:${esc(x.email)}">${esc(x.email)}</a>` : ''}</small></div>`).join('') : '<small>Nessun contatto: aggiungili dal tuo account.</small>'}`;
    },
    async approvare(box) {
      const n = (await api('/richieste/conteggio')).n;
      box.innerHTML = `<h4>Richieste da approvare</h4><div class="r"><b>${n}</b> ${n === 1 ? 'richiesta di accesso' : 'richieste di accesso'}${n ? '<br><a class="vl" href="/admin.html#richieste">Apri le richieste</a>' : ''}</div>`;
    },
  };

  const apriGrande = (c) => {
    let d = document.getElementById('dlgcal'); if (!d) { d = document.createElement('dialog'); d.id = 'dlgcal'; document.body.append(d); d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); }
    d.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><strong>Calendario</strong><button type="button" id="dc_x">Chiudi</button></div><div id="dc_b"></div>';
    if (window.Barra) d.style.setProperty('--sez', Barra.colore(Barra.sezione()));
    d.showModal(); d.querySelector('#dc_x').onclick = () => d.close();
    COSTRUTTORI.calendario(d.querySelector('#dc_b'), c, true);
  };
  window.Widget = {
    // calendario compatto per la colonna di sinistra, con il tasto per aprirlo in una finestra
    async calendario(box) {
      if (!box) return; const me = leggi('me'); let eventi = []; try { eventi = await api('/eventi'); } catch { /* offline */ }
      box.classList.add('calw'); if (window.Barra) box.style.setProperty('--sez', Barra.colore(Barra.sezione()));
      await COSTRUTTORI.calendario(box, { me, eventi });
    },
    scelti, disponibili,
    // disegna i widget scelti dall'utente nel contenitore
    async disegna(box, { mondo } = {}) {
      const me = leggi('me'); if (!box || !me) return;
      const chi = scelti(me);
      if (!chi.length) { box.innerHTML = '<a class="wl" href="/#account">Scegli i widget</a>'; return; }
      let eventi = []; try { eventi = await api('/eventi'); } catch { /* offline */ }
      const ctx = { me, mondo, eventi };
      box.className = 'widgets';
      const fine = '<a class="wl" href="/#account">Scegli i widget</a>';
      box.innerHTML = chi.map((k) => `<section class="wd" data-w="${k}"><small>Carico…</small></section>`).join('');
      box.insertAdjacentHTML('beforeend', fine);
      await Promise.all(chi.map(async (k) => { const el = box.querySelector(`[data-w="${k}"]`); try { await COSTRUTTORI[k](el, ctx); } catch { el.remove(); } }));
    },
    // scheda «I miei widget» per l'area utente
    editor(box, dopo) {
      const me = leggi('me'); let ordine = scelti(me), contatti = (me.preferenze?.contatti || []).map((c) => ({ ...c }));
      const disp = disponibili(me), nome = (k) => CAT.find((c) => c[0] === k);
      const disegna = () => {
        const tutti = [...ordine, ...disp.map((c) => c[0]).filter((k) => !ordine.includes(k))];
        box.innerHTML = `<div class="card wed"><h2>I miei widget</h2><p><small>Scegli cosa vedere nella tua Home e in che ordine.</small></p>
          ${tutti.map((k) => { const c = nome(k), on = ordine.includes(k), i = ordine.indexOf(k); return `<div class="rg"><input type="checkbox" id="we_${k}" data-k="${k}" ${on ? 'checked' : ''}><label for="we_${k}"><b>${esc(c[1])}</b><small>${esc(c[2])}</small></label>
            ${on ? `<button type="button" class="sec" data-su="${k}" ${i === 0 ? 'disabled' : ''} aria-label="Sposta su">▲</button><button type="button" class="sec" data-giu="${k}" ${i === ordine.length - 1 ? 'disabled' : ''} aria-label="Sposta giù">▼</button>` : ''}</div>`; }).join('')}
          <h3 style="margin-top:14px">Contatti preferiti</h3><p><small>Compaiono nel widget «Contatti preferiti». Servono il nome e almeno un numero o un'email.</small></p>
          ${contatti.map((c, i) => `<div class="ct"><input data-c="${i}" data-f="nome" value="${esc(c.nome)}" placeholder="Nome" aria-label="Nome"><input data-c="${i}" data-f="tel" value="${esc(c.tel)}" placeholder="Telefono" aria-label="Telefono" inputmode="tel"><input data-c="${i}" data-f="email" value="${esc(c.email)}" placeholder="Email" aria-label="Email" inputmode="email"><button type="button" class="sec" data-x="${i}">Togli</button></div>`).join('')}
          <button type="button" class="btn sec" id="we_add" ${contatti.length >= 20 ? 'disabled' : ''}>Aggiungi un contatto</button>
          <p><button type="button" class="btn" id="we_ok">Salva</button> <span id="we_msg" role="status"></span></p></div>`;
        box.querySelectorAll('[data-k]').forEach((x) => { x.onchange = () => { ordine = x.checked ? [...ordine, x.dataset.k] : ordine.filter((k) => k !== x.dataset.k); disegna(); }; });
        box.querySelectorAll('[data-su],[data-giu]').forEach((b) => { b.onclick = () => { const k = b.dataset.su || b.dataset.giu, i = ordine.indexOf(k), j = b.dataset.su ? i - 1 : i + 1; [ordine[i], ordine[j]] = [ordine[j], ordine[i]]; disegna(); }; });
        box.querySelectorAll('[data-c]').forEach((x) => { x.oninput = () => { contatti[x.dataset.c][x.dataset.f] = x.value; }; });
        box.querySelectorAll('[data-x]').forEach((b) => { b.onclick = () => { contatti.splice(Number(b.dataset.x), 1); disegna(); }; });
        box.querySelector('#we_add').onclick = () => { contatti.push({ nome: '', tel: '', email: '' }); disegna(); };
        box.querySelector('#we_ok').onclick = async () => {
          const msg = box.querySelector('#we_msg');
          try {
            const pref = await api('/me/preferenze', { method: 'PUT', body: { widget: ordine, contatti } });
            const m = leggi('me') || me; m.preferenze = pref; localStorage.setItem('me', JSON.stringify(m)); if (dopo) dopo(pref);
            contatti = (pref.contatti || []).map((c) => ({ ...c })); disegna(); box.querySelector('#we_msg').textContent = 'Salvato. Li trovi nella Home.';
          } catch (e) { msg.textContent = 'Non salvato: ' + e.message; }
        };
      };
      disegna();
    },
  };
})();
