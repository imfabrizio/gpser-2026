// Aspetto dell'applicazione: tre layout (a rosso pieno, b colonna rossa, c bianco con croci). Si applica subito e, se l'utente è collegato, si ricorda sul suo profilo.
(function () {
  const OK = ['a', 'b', 'c'];
  const leggi = () => { try { return localStorage.getItem('tema'); } catch { return null; } };
  const applica = (t) => { document.documentElement.dataset.tema = OK.includes(t) ? t : 'a'; };
  applica(leggi());
  const NOMI = { a: ['Rosso pieno', 'Pagina rossa, logo grande, riquadri bianchi'], b: ['Colonna rossa', 'Fascia rossa laterale, riquadri con bordo rosso'], c: ['Bianco con croci', 'Pagina chiara, titolo su fondo a croci'] };
  const anteprima = (t) => {
    const r = '#C8102E', box = (s) => `<div style="width:100%;height:78px;border-radius:6px;overflow:hidden;position:relative;${s}">`;
    const tile = '<i style="display:block;width:30%;height:22px;background:#fff;border:1px solid #D3D7DE;border-radius:3px"></i>';
    if (t === 'a') return box(`background:${r}`) + `<b style="position:absolute;left:8px;top:8px;width:18px;height:18px;background:#fff;border-radius:4px"></b><b style="position:absolute;left:8px;top:32px;width:60%;height:12px;background:#fff;border-radius:2px"></b><span style="position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:5px">${tile}${tile}${tile}</span></div>`;
    if (t === 'b') return box('background:#F1F2F5') + `<b style="position:absolute;left:0;top:0;bottom:0;width:30%;background:${r}"></b><span style="position:absolute;left:36%;right:6px;top:10px;display:flex;gap:5px;flex-wrap:wrap"><i style="display:block;width:45%;height:22px;background:#fff;border-top:4px solid ${r}"></i><i style="display:block;width:45%;height:22px;background:#fff;border-top:4px solid ${r}"></i><i style="display:block;width:45%;height:22px;background:#fff;border-top:4px solid ${r}"></i></span></div>`;
    return box('background:#fff;border:1px solid #D3D7DE') + `<b style="position:absolute;left:0;right:0;top:0;height:5px;background:${r}"></b><b style="position:absolute;left:0;right:0;top:16px;height:26px;background:#FBE9EC"></b><span style="position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:5px">${tile}${tile}${tile}</span></div>`;
  };
  function scegli() {
    if (document.getElementById('tema-dlg')) return;
    const corr = document.documentElement.dataset.tema;
    const w = document.createElement('div'); w.id = 'tema-dlg';
    w.style.cssText = 'position:fixed;inset:0;background:#0007;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px';
    w.innerHTML = `<div role="dialog" aria-label="Aspetto" style="background:#fff;color:#1B1F27;border-radius:12px;padding:18px;max-width:760px;width:100%;max-height:92vh;overflow:auto">
      <h3 style="margin:0 0 4px;font-size:22px">Aspetto</h3><p style="margin:0 0 12px;font-size:14px;color:#5B6270">Scegli come vuoi vedere l'applicazione. Vale per il tuo accesso.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px">${OK.map((t) => `<button type="button" data-t="${t}" style="text-align:left;background:#fff;color:inherit;border:2.5px solid ${t === corr ? '#C8102E' : '#D3D7DE'};border-radius:10px;padding:10px;cursor:pointer;font:inherit">${anteprima(t)}<b style="display:block;margin-top:8px;font-size:16px">${NOMI[t][0]}${t === corr ? ' ✓' : ''}</b><span style="font-size:13px;color:#5B6270">${NOMI[t][1]}</span></button>`).join('')}</div>
      <p style="margin:14px 0 0;text-align:right"><button type="button" id="tema-x" style="background:#fff;color:#1B1F27;border:1.5px solid #8C94A3;border-radius:8px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer">Chiudi</button></p></div>`;
    document.body.appendChild(w);
    const chiudi = () => w.remove();
    w.onclick = (e) => { if (e.target === w) chiudi(); };
    w.querySelector('#tema-x').onclick = chiudi;
    w.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => { imposta(b.dataset.t); chiudi(); }; });
  }
  function imposta(t) {
    if (!OK.includes(t)) return;
    applica(t); try { localStorage.setItem('tema', t); } catch { /* ignora */ }
    let tk = null; try { tk = localStorage.getItem('token'); } catch { /* ignora */ }
    if (tk) fetch('/api/me/tema', { method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ tema: t }) }).catch(() => {});
  }
  // il profilo sul server (se l'utente ha già scelto) vince su ciò che è salvato nel browser
  function sync(me) { if (me && OK.includes(me.tema)) { applica(me.tema); try { localStorage.setItem('tema', me.tema); } catch { /* ignora */ } } }
  window.GareTema = { scegli, imposta, sync };
})();
