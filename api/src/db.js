import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/garecri';

export function creaPool(url = DATABASE_URL) {
  const pool = new pg.Pool({
    connectionString: url, max: 10,
    idleTimeoutMillis: 30_000,          // chiude le connessioni inattive prima che il database (es. Neon) le sospenda
    connectionTimeoutMillis: 20_000,    // tollera l'avvio a freddo di un database sospeso
    keepAlive: true,
  });
  // senza questo handler, una connessione chiusa dal server mentre è inattiva fa cadere l'intero processo
  pool.on('error', (e) => console.error('connessione DB inattiva chiusa:', e.message));
  return pool;
}

/** Esegue fn(client) in una transazione. */
export async function inTransazione(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
