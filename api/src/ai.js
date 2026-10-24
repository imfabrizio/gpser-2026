// Generazione di bozze di schede con un modello AI. Chiave predefinita: GEMINI_API_KEY (impostata su Render, mai nel codice);
// in alternativa la chiave personale dell'utente (Gemini, Claude o ChatGPT), conservata cifrata.
const MODELLI = { gemini: process.env.GEMINI_MODEL || 'gemini-2.5-flash', anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', openai: process.env.OPENAI_MODEL || 'gpt-4o-mini' };

export const PROVIDER = ['gemini', 'anthropic', 'openai'];

export function promptScheda({ argomento, indicazioni, nVoci }) {
  return `Sei un istruttore della Croce Rossa Italiana che prepara schede di valutazione per prove pratiche di primo soccorso.
Crea una scheda di valutazione sul tema: "${argomento}".
${indicazioni ? `Indicazioni dell'istruttore: ${indicazioni}\n` : ''}Regole:
- circa ${nVoci || 20} voci, ognuna una azione osservabile e verificabile, scritta all'infinito o in terza persona ("Si presenta e valuta la scena"), una riga ciascuna;
- raggruppale in sezioni con titolo breve in maiuscolo (es. AUTOPROTEZIONE E SICUREZZA, VALUTAZIONE PRIMARIA, TRATTAMENTO, PASSAGGIO DI CONSEGNE);
- niente dosaggi o valori clinici non sicuri: se non sei certo di un dato, lascia la voce generica;
- rispondi SOLO con JSON, senza testo attorno, in questo formato:
{"nome": "...", "sigla": "tre lettere maiuscole", "sezioni": [{"sezione": "...", "voci": ["...", "..."]}]}`;
}

// estrae e valida il JSON restituito dal modello
export function leggiScheda(testo) {
  const m = String(testo || '').match(/\{[\s\S]*\}/); if (!m) throw new Error('risposta del modello non leggibile');
  let j; try { j = JSON.parse(m[0]); } catch { throw new Error('risposta del modello non leggibile'); }
  const sezioni = (Array.isArray(j.sezioni) ? j.sezioni : []).map((s) => ({ sezione: String(s.sezione || '').trim().slice(0, 80), voci: (Array.isArray(s.voci) ? s.voci : []).map((v) => String(v).trim().slice(0, 300)).filter(Boolean) })).filter((s) => s.sezione && s.voci.length);
  const n = sezioni.reduce((a, s) => a + s.voci.length, 0);
  if (!j.nome || n < 3) throw new Error('il modello non ha prodotto una scheda utilizzabile');
  if (n > 80) throw new Error('scheda troppo lunga');
  return { nome: String(j.nome).trim().slice(0, 120), sigla: String(j.sigla || j.nome).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 3).padEnd(3, 'X'), sezioni };
}

export async function chiama(provider, chiave, prompt, f = fetch) {
  const modello = MODELLI[provider];
  let r, estrai;
  if (provider === 'gemini') {
    r = await f(`https://generativelanguage.googleapis.com/v1beta/models/${modello}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chiave },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }) });
    estrai = (j) => j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  } else if (provider === 'anthropic') {
    r = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': chiave, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: modello, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }) });
    estrai = (j) => j.content?.map((c) => c.text || '').join('') || '';
  } else if (provider === 'openai') {
    r = await f('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + chiave },
      body: JSON.stringify({ model: modello, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.4 }) });
    estrai = (j) => j.choices?.[0]?.message?.content || '';
  } else throw new Error('provider non supportato');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403 || r.status === 400 && /API key/i.test(JSON.stringify(j)) ? 'chiave AI non valida o non autorizzata' : r.status === 429 ? 'limite gratuito del servizio AI raggiunto: riprova più tardi' : 'il servizio AI non ha risposto (' + r.status + ')');
  return estrai(j);
}
