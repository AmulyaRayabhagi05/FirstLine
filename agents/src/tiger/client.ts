import pg from 'pg';

let pool: pg.Pool | null = null;

/** Shared pool built from TIGER_DATABASE_URL (lazily). */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.TIGER_DATABASE_URL;
  if (!url) throw new Error('TIGER_DATABASE_URL is not set (see agents/.env.example)');
  pool = createPool(url);
  return pool;
}

export function createPool(connectionString: string): pg.Pool {
  const needsSsl = /sslmode=(require|verify)/.test(connectionString) || /tsdb\.cloud\.timescale\.com/.test(connectionString);
  const p = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  });
  p.on('error', (err) => console.error('[tiger] idle client error', err.message));
  return p;
}

/** Use a specific pool (tests, or a worker that manages its own). */
export function setPool(p: pg.Pool | null): void {
  pool = p;
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}

export type Queryable = Pick<pg.Pool, 'query'>;
