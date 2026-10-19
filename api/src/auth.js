import crypto from 'node:crypto';

const secret = () => process.env.JWT_SECRET || 'solo-per-sviluppo-e-test';
export function verificaConfigurazione() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET mancante o più corto di 32 caratteri: impostalo prima di avviare il server');
}
const b64 = (b) => Buffer.from(b).toString('base64url');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 32);
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function verificaPassword(pw, stored) {
  const [alg, salt, h] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}
export function firmaToken(payload, ore = 12) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + ore * 3600e3 }));
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
export function leggiToken(token) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const ok = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(ok))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

// limite ai tentativi di login: 8 errori ogni 15 minuti per coppia ip+email (in memoria, per un solo processo)
const falliti = new Map();
export function troppiTentativi(chiave) {
  const r = falliti.get(chiave);
  return !!r && r.n >= 8 && Date.now() - r.t < 15 * 60e3;
}
setInterval(() => { const ora = Date.now(); for (const [k, r] of falliti) if (ora - r.t > 15 * 60e3) falliti.delete(k); }, 5 * 60e3).unref();
export function registraFallimento(chiave) {
  const r = falliti.get(chiave);
  falliti.set(chiave, !r || Date.now() - r.t > 15 * 60e3 ? { n: 1, t: Date.now() } : { n: r.n + 1, t: r.t });
}
export function azzeraFallimenti(chiave) { falliti.delete(chiave); }
const FINTO = hashPassword('password-finta-per-uniformare-i-tempi');
export const verificaPasswordFinta = (pw) => verificaPassword(pw, FINTO);
