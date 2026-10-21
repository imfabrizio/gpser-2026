import crypto from 'node:crypto';
// TOTP (RFC 6238, SHA-1, 6 cifre, 30 s) con le sole librerie di Node.
const ALF = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (buf) => { let bit = 0, v = 0, o = ''; for (const b of buf) { v = (v << 8) | b; bit += 8; while (bit >= 5) { o += ALF[(v >>> (bit - 5)) & 31]; bit -= 5; } } if (bit) o += ALF[(v << (5 - bit)) & 31]; return o; };
export const daBase32 = (s) => { let bit = 0, v = 0; const o = []; for (const c of s.replace(/[\s=]/g, '').toUpperCase()) { const i = ALF.indexOf(c); if (i < 0) throw new Error('base32'); v = (v << 5) | i; bit += 5; if (bit >= 8) { o.push((v >>> (bit - 8)) & 255); bit -= 8; } } return Buffer.from(o); };
export const nuovoSegreto = () => base32(crypto.randomBytes(20));
export function totp(segretoB32, tempoMs = Date.now(), cifre = 6) {
  const passo = Math.floor(tempoMs / 30000); const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', daBase32(segretoB32)).update(buf).digest();
  const o = h[h.length - 1] & 15; const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** cifre).padStart(cifre, '0');
}
export function verificaTotp(segretoB32, codice, tempoMs = Date.now()) {   // tolleranza di ±1 passo (orologi non perfetti)
  const c = String(codice || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(totp(segretoB32, tempoMs + d * 30000)), Buffer.from(c)));
}
const chiave = () => crypto.createHash('sha256').update((process.env.JWT_SECRET || 'solo-per-sviluppo-e-test') + ':mfa').digest();
export function cifra(testo) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', chiave(), iv); const d = Buffer.concat([c.update(testo, 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map((x) => x.toString('base64url')).join('.'); }
export function decifra(s) { const [iv, tag, d] = s.split('.').map((x) => Buffer.from(x, 'base64url')); const c = crypto.createDecipheriv('aes-256-gcm', chiave(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); }
export const otpauth = (segreto, email) => `otpauth://totp/GareCRI:${encodeURIComponent(email)}?secret=${segreto}&issuer=GareCRI&digits=6&period=30`;
const hashCodice = (c) => crypto.createHash('sha256').update(c.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
export function nuoviCodiciRecupero(n = 8) { const chiari = Array.from({ length: n }, () => { const x = crypto.randomBytes(5).toString('hex').toUpperCase(); return `${x.slice(0, 5)}-${x.slice(5)}`; }); return { chiari, hash: chiari.map(hashCodice) }; }
export const hashRecupero = hashCodice;
