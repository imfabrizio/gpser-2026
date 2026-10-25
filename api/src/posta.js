// Email transazionali via Resend. Senza RESEND_API_KEY non invia nulla: resta la notifica nell'app.
export async function inviaMail(a, oggetto, testo) {
  const chiave = process.env.RESEND_API_KEY;
  if (!chiave || !a) return false;
  try {
    const r = await globalThis.fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${chiave}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.NOTIFICA_DA || 'GareCRI <onboarding@resend.dev>', to: [a], subject: oggetto, text: testo }) });
    return r.ok;
  } catch { return false; }          // la mail è un di più: l'esito resta comunque nell'app
}
export const URL_BASE = () => process.env.PUBLIC_URL || '';
