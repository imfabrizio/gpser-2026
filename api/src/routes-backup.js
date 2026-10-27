// Backup: solo admin (elenco, esegui ora, scarica) e un'entrata con chiave per la pianificazione esterna (GitHub Actions).
import crypto from 'node:crypto';
import { httpErr } from './services/compilazioni.js';
import { configurazione, eseguiBackup, dumpDb, zipSito, cifra } from './backup.js';

export function registraBackup(app, pool, { soloAdmin }) {
  app.get('/api/backup', { preHandler: soloAdmin }, async () => ({
    config: configurazione(),
    elenco: (await pool.query(`select id, creato_il, tipo, ok, nome, dimensione, destinazione, errore from backup_log order by creato_il desc limit 40`)).rows,
  }));
  app.post('/api/backup', { preHandler: soloAdmin }, async (req) => eseguiBackup(pool, { tipo: 'manuale', utenteId: req.utente.id }));
  // download diretto: database (cifrato se c'è la frase, altrimenti compresso e basta) o archivio del sito
  app.get('/api/backup/scarica', { preHandler: soloAdmin }, async (req, reply) => {
    const t = req.query.tipo, data = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    if (t === 'sito') return reply.type('application/zip').header('Content-Disposition', `attachment; filename="gpser-sito-${data}.zip"`).send(await zipSito());
    if (t !== 'db') throw httpErr(400, 'tipo: db oppure sito');
    const frase = process.env.BACKUP_PASSPHRASE, dump = await dumpDb(pool);
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="gpser-db-${data}.${frase ? 'gpsb' : 'json.gz'}"`).send(frase ? cifra(dump, frase) : dump);
  });
  // pianificazione: GitHub Actions chiama questa rotta ogni 6 ore con la chiave condivisa; se l'ultimo backup riuscito è recente non ne fa un altro
  app.post('/api/backup/automatico', async (req) => {
    const chiave = process.env.BACKUP_CRON_TOKEN, dato = String(req.headers['x-backup-token'] || '');
    const a = Buffer.from(dato), b = Buffer.from(chiave || '');
    if (!chiave || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpErr(401, 'non autorizzato');
    const { rowCount } = await pool.query(`select 1 from backup_log where ok and tipo='automatico' and nome like 'db/%' and creato_il > now() - interval '5 hours'`);
    if (rowCount) return { saltato: true, motivo: 'ultimo backup recente' };
    const r = await eseguiBackup(pool, { tipo: 'automatico' });
    if (!r.ok) throw httpErr(500, r.errore || 'backup non riuscito');
    return { ok: true, nome: r.nome };
  });
}
