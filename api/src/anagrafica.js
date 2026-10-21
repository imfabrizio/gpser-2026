import crypto from 'node:crypto';
import { cifra } from './mfa.js';
// codice fiscale in anagrafica: cifrato, con un hash (HMAC) per cercarlo e impedire duplicati senza conservarlo in chiaro
const chiaveHash = () => crypto.createHash('sha256').update((process.env.JWT_SECRET || 'solo-per-sviluppo-e-test') + ':cf').digest();
export const hashCf = (cf) => crypto.createHmac('sha256', chiaveHash()).update(String(cf).toUpperCase()).digest('base64url');
export const datiCf = (cf) => (cf ? { cf_cifrato: cifra(cf), cf_hash: hashCf(cf) } : { cf_cifrato: null, cf_hash: null });

// all'avvio: i codici fiscali eventualmente salvati in chiaro (prima versione) vengono cifrati
export async function cifraCodiciInChiaro(pool) {
  const { rows } = await pool.query(`select id, codice_fiscale from partecipante where codice_fiscale is not null and cf_cifrato is null`);
  for (const r of rows) {
    const cf = r.codice_fiscale.toUpperCase(); const d = datiCf(cf);
    await pool.query(`update partecipante set cf_cifrato=$2, cf_hash=$3, codice_fiscale=null where id=$1 and not exists (select 1 from partecipante q where q.cf_hash=$3)`, [r.id, d.cf_cifrato, d.cf_hash]);
  }
  return rows.length;
}
