import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pool: pg.Pool | null = null;

/** Shared pool built from TIGER_DATABASE_URL (lazily). */
export function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.TIGER_DATABASE_URL;
  if (!url) throw new Error('TIGER_DATABASE_URL is not set (see agents/.env.example)');
  pool = createPool(url);
  return pool;
}

// Tiger Cloud signs server certs with its own CA (CN=ca.timescale.com), which Node does not
// trust by default. Verify against that CA instead of turning verification off.
const TIMESCALE_CA_PATH = fileURLToPath(new URL('../../../db/tiger/timescale-ca.pem', import.meta.url));

function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  const isTigerCloud = /\.tsdb\.cloud\.timescale\.com/.test(connectionString);
  const wantsSsl = /sslmode=(require|verify-ca|verify-full)/.test(connectionString);
  if (isTigerCloud) {
    const caPath = process.env.TIGER_CA_CERT || TIMESCALE_CA_PATH;
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  return wantsSsl ? { rejectUnauthorized: true } : undefined;
}

export function createPool(connectionString: string): pg.Pool {
  // pg lets `sslmode` in the URL override the `ssl` object, so drop it and pass TLS settings explicitly.
  const url = connectionString.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
  const p = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: sslFor(connectionString),
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
