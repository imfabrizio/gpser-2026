// Codice della pagina classifica.html: sta in un file a parte perché la Content-Security-Policy del sito non ammette script scritti dentro le pagine.
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const par = new URLSearchParams(location.search);
const token = localStorage.getItem('token');
const evId = par.get('ev') || localStorage.getItem('ev');
const TIPI = [['generale', 'Generale'], ['sep', 'SEP'], ['bls', 'BLSD'], ['master', 'Master'], ['diu', 'DIU']];
let tipo = TIPI.some(([k]) => k === par.get('tipo')) ? par.get('tipo') : 'generale';
let punti = par.get('punti') !== '0';
async function api(p) {
  const r = await fetch('/api' + p, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).errore || r.statusText), { status: r.status });
  return r.json();
}
function disegnaTipi() {
  $('#tipi').innerHTML = TIPI.map(([k, n]) => `<button data-k="${k}" class="${k === tipo ? 'on' : ''}">${n}</button>`).join(' ');
  document.querySelectorAll('#tipi button').forEach((b) => { b.onclick = () => { tipo = b.dataset.k; disegnaTipi(); carica(); }; });
  $('#pt').textContent = 'Punti: ' + (punti ? 'sì' : 'no');
}
async function carica() {
  if (!token || !evId) { $('#m').innerHTML = '<div class="msg">Per proiettare la classifica entra da <a href="/admin.html#classifiche">Gestione → Classifiche</a>.</div>'; return; }
  try {
    const [r, eventi] = await Promise.all([api(`/eventi/${evId}/classifica?tipo=${tipo}`), api('/eventi')]);
    const e = eventi.find((x) => x.id === evId) || {};
    const nome = (TIPI.find(([k]) => k === tipo) || [])[1];
    $('#t').textContent = `Classifica ${nome}`; document.title = `Classifica ${nome} · ${e.nome || ''}`;
    $('#s').textContent = [e.nome, e.luogo, e.data ? String(e.data).slice(0, 10).split('-').reverse().join('/') : ''].filter(Boolean).join(' · ');
    $('#pdf').href = '#'; 
    const val = (c) => Number(c.valore ?? (tipo === 'generale' ? c.totale : c[tipo]));
    const pt = (c) => punti ? `<span class="pt">${val(c)}</span>` : '';
    const top = r.classifica.filter((c) => c.posizione <= 3), resto = r.classifica.filter((c) => c.posizione > 3);
    $('#m').innerHTML = r.classifica.length ? `<div class="podio">${top.map((c) => `<div class="p p${c.posizione}"><span class="pos">${c.posizione}</span><span class="nm">${esc(c.nome)}</span>${pt(c)}</div>`).join('')}</div>
      <div class="resto">${resto.map((c) => `<div class="r"><span class="pos">${c.posizione}</span><span class="nm">${esc(c.nome)}</span>${pt(c)}</div>`).join('')}</div>` : '<div class="msg">Nessun punteggio ancora.</div>';
    $('#ag').textContent = 'Aggiornata alle ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (err) {
    $('#m').innerHTML = err.status === 401 || err.status === 403 ? '<div class="msg">Accesso non consentito. <a href="/">Entra</a> con un account abilitato alle classifiche.</div>' : `<div class="msg">Aggiornamento non riuscito: ${esc(err.message)}. Riprovo tra poco.</div>`;
  }
}
$('#pt').onclick = () => { punti = !punti; disegnaTipi(); carica(); };
document.addEventListener('fullscreenchange', () => document.body.classList.toggle('schermo', !!document.fullscreenElement));   // a schermo intero (proiettore) le barre laterali spariscono
window.addEventListener('load', () => { window.Barra && Barra.disegna('classifica'); window.Layout && Layout.disegna(); });
$('#fs').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); };
$('#pdf').onclick = async (ev) => {
  ev.preventDefault();
  try { const r = await fetch(`/api/eventi/${evId}/classifica.pdf?tipo=${tipo}`, { headers: { Authorization: 'Bearer ' + token } }); if (!r.ok) throw new Error(); window.open(URL.createObjectURL(await r.blob()), '_blank'); }
  catch { alert('PDF non disponibile'); }
};
// i comandi spariscono quando non servono (proiezione pulita)
let quieto; const sveglia = () => { document.body.classList.remove('quiet'); clearTimeout(quieto); quieto = setTimeout(() => document.body.classList.add('quiet'), 5000); };
['mousemove', 'keydown', 'touchstart'].forEach((e) => addEventListener(e, sveglia)); sveglia();
disegnaTipi(); carica(); setInterval(carica, 20000);
