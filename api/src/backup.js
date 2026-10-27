// Backup del database (tutte le tabelle in JSON, compresso e cifrato) e del sito (codice e file statici in uno zip).
// Destinazione: repository GitHub privato (BACKUP_GITHUB_TOKEN + BACKUP_GITHUB_REPO). Il database non lascia mai il server in chiaro:
// senza BACKUP_PASSPHRASE il backup su GitHub si rifiuta. Il disco di Render è effimero, quindi nulla resta in locale.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const RADICE = fileURLToPath(new URL('../../', import.meta.url));
const MAGIA = Buffer.from('GPSB1');
const GIORNI = () => Math.max(7, Number(process.env.BACKUP_GIORNI) || 30);     // quanti giorni tenere su GitHub

export const configurazione = () => ({
  cifratura: !!process.env.BACKUP_PASSPHRASE,
  github: !!(process.env.BACKUP_GITHUB_TOKEN && process.env.BACKUP_GITHUB_REPO),
  repo: process.env.BACKUP_GITHUB_REPO || null,
  pianificazione: !!process.env.BACKUP_CRON_TOKEN,
  giorni: GIORNI(),
});

// ── cifratura: AES-256-GCM, chiave derivata dalla frase con scrypt; file = GPSB1 | sale | iv | tag | dati ──
export function cifra(buf, frase) {
  const sale = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(frase, sale, 32), iv);
  const dati = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIA, sale, iv, c.getAuthTag(), dati]);
}
export function decifra(file, frase) {
  if (!file.subarray(0, 5).equals(MAGIA)) throw new Error('non è un backup GPSER cifrato');
  const sale = file.subarray(5, 21), iv = file.subarray(21, 33), tag = file.subarray(33, 49);
  const d = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(frase, sale, 32), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(file.subarray(49)), d.final()]); } catch { throw new Error('frase errata o file danneggiato'); }
}

// ── database: ogni tabella come JSON (row_to_json mantiene date, jsonb e bytea esattamente come sono) ──
export async function dumpDb(pool) {
  const { rows: tab } = await pool.query(`select tablename from pg_tables where schemaname='public' order by tablename`);
  const tabelle = {};
  for (const { tablename } of tab) tabelle[tablename] = (await pool.query(`select coalesce(json_agg(row_to_json(t)), '[]'::json) as r from "${tablename.replace(/"/g, '""')}" t`)).rows[0].r;
  return zlib.gzipSync(Buffer.from(JSON.stringify({ formato: 'gpser-backup-1', creato_il: new Date().toISOString(), tabelle })));
}

// ── sito: codice, pagine, migrazioni e risorse (non node_modules) ──
const CARTELLE = ['web', 'api', 'db', 'assets', 'docs', 'tools', 'scripts'], FILE = ['package.json', 'package-lock.json', 'render.yaml', 'README.md'];
export async function zipSito() {
  const zip = new JSZip();
  const giu = (rel) => {
    const p = path.join(RADICE, rel); if (!fs.existsSync(p)) return;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) giu(r); else if (e.isFile() && fs.statSync(path.join(RADICE, r)).size < 20 * 1024 * 1024) zip.file(r, fs.readFileSync(path.join(RADICE, r)));
    }
  };
  CARTELLE.forEach(giu); for (const f of FILE) if (fs.existsSync(path.join(RADICE, f))) zip.file(f, fs.readFileSync(path.join(RADICE, f)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

// ── GitHub ──
const gh = (fetchImpl, token) => (url, opt = {}) => fetchImpl(`https://api.github.com/${url}`, { ...opt, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gpser-backup', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
export async function inviaAGithub(buf, percorso, { fetchImpl = globalThis.fetch } = {}) {
  const { BACKUP_GITHUB_TOKEN: token, BACKUP_GITHUB_REPO: repo } = process.env;
  const r = await gh(fetchImpl, token)(`repos/${repo}/contents/${percorso}`, { method: 'PUT', body: JSON.stringify({ message: `Backup ${percorso}`, content: buf.toString('base64') }) });
  if (!r.ok) throw new Error(`GitHub ha risposto ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
}
// toglie i backup più vecchi del periodo di conservazione (un errore qui non fa fallire il backup)
export async function potaGithub({ fetchImpl = globalThis.fetch, adesso = Date.now() } = {}) {
  const { BACKUP_GITHUB_TOKEN: token, BACKUP_GITHUB_REPO: repo } = process.env, g = gh(fetchImpl, token); let tolti = 0;
  for (const cartella of ['db', 'sito']) {
    const r = await g(`repos/${repo}/contents/${cartella}`); if (!r.ok) continue;
    for (const f of await r.json()) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(f.name); if (!m) continue;
      if (adesso - Date.UTC(+m[1], +m[2] - 1, +m[3]) > GIORNI() * 86400000) { const d = await g(`repos/${repo}/contents/${f.path}`, { method: 'DELETE', body: JSON.stringify({ message: `Rimosso ${f.name}`, sha: f.sha }) }); if (d.ok) tolti++; }
    }
  }
  return tolti;
}

const stampaData = (d) => d.toISOString().replace(/[:T]/g, '-').slice(0, 16);   // 2026-10-27-22-30
export async function eseguiBackup(pool, { tipo = 'manuale', utenteId = null, fetchImpl = globalThis.fetch } = {}) {
  const cfg = configurazione(), adesso = new Date(), nome = `${stampaData(adesso)}-${tipo}.gpsb`;
  let dest = 'solo registro', dimensione = 0;
  try {
    if (!cfg.github) throw new Error('GitHub non configurato: imposta BACKUP_GITHUB_TOKEN e BACKUP_GITHUB_REPO su Render');
    if (!cfg.cifratura) throw new Error('imposta BACKUP_PASSPHRASE su Render: il database non si invia mai in chiaro');
    const db = cifra(await dumpDb(pool), process.env.BACKUP_PASSPHRASE); dimensione = db.length;
    await inviaAGithub(db, `db/${nome}`, { fetchImpl });
    const oggi = adesso.toISOString().slice(0, 10);                                    // il sito una volta al giorno
    const { rowCount } = await pool.query(`select 1 from backup_log where ok and nome like 'sito/%' and creato_il::date = $1::date`, [oggi]);
    if (!rowCount) { const z = await zipSito(); await inviaAGithub(z, `sito/${stampaData(adesso)}.zip`, { fetchImpl }); await pool.query(`insert into backup_log (tipo, ok, nome, dimensione, destinazione, eseguito_da) values ($1,true,$2,$3,'github',$4)`, [tipo, `sito/${stampaData(adesso)}.zip`, z.length, utenteId]); }
    await potaGithub({ fetchImpl }).catch(() => {});
    dest = `github · ${cfg.repo}`;
    const { rows: [r] } = await pool.query(`insert into backup_log (tipo, ok, nome, dimensione, destinazione, eseguito_da) values ($1,true,$2,$3,$4,$5) returning *`, [tipo, `db/${nome}`, dimensione, dest, utenteId]);
    return r;
  } catch (e) {
    const { rows: [r] } = await pool.query(`insert into backup_log (tipo, ok, nome, dimensione, destinazione, errore, eseguito_da) values ($1,false,$2,$3,$4,$5,$6) returning *`, [tipo, `db/${nome}`, dimensione || null, dest, String(e.message).slice(0, 300), utenteId]);
    return r;
  }
}
