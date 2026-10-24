// Suggerimenti per il campo «comitato»: si scrivono le prime lettere e compaiono i comitati (con la provincia).
// Scelto un comitato, la provincia e l'unità territoriale si compilano da sole (unità = il comitato stesso se non ne ha altre).
window.legaComitato = function (input, opt = {}) {
  if (!input || input.dataset.lc) return; input.dataset.lc = '1';
  const dl = document.createElement('datalist'); dl.id = 'dl_' + Math.random().toString(36).slice(2); document.body.append(dl);
  input.setAttribute('list', dl.id); input.setAttribute('autocomplete', 'off');
  let mappa = {}, timer;
  const applica = () => {
    const m = mappa[input.value]; if (!m) return;
    if (opt.provincia && !opt.provincia.value && m.provincia) opt.provincia.value = m.provincia;
    const u = opt.unita; if (!u) return;
    if (u.tagName === 'SELECT') { const cur = u.value; u.innerHTML = m.unita.map((x) => `<option>${x.replace(/[<&"]/g, '')}</option>`).join(''); u.value = m.unita.includes(cur) ? cur : m.unita[0]; }
    else if (!u.value || m.unita.length === 1) u.value = m.unita[0];
  };
  const cerca = async () => {
    try {
      const prov = opt.provincia && opt.provincia.value.trim().length === 2 ? '&provincia=' + encodeURIComponent(opt.provincia.value.trim()) : '';
      const r = await fetch('/api/comitati/cerca?q=' + encodeURIComponent(input.value) + prov, { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
      if (!r.ok) return; const l = await r.json();
      mappa = Object.fromEntries(l.map((c) => [c.nome, c]));
      dl.innerHTML = l.map((c) => `<option value="${c.nome.replace(/"/g, '&quot;')}" label="${c.provincia ? c.provincia : ''}">`).join('');
      applica();
    } catch { /* senza rete resta il campo libero */ }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(cerca, 200); applica(); });
  input.addEventListener('change', applica); input.addEventListener('focus', cerca);
};
