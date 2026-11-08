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

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * TLS policy: Tiger Cloud verifies against its bundled CA; any other remote host verifies against
 * the system CAs (TLS on by default, so credentials and personal data never cross the network in
 * plaintext); localhost or an explicit sslmode=disable connects without TLS.
 */
export function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  if (/sslmode=disable/.test(connectionString)) return undefined;
  const isTigerCloud = /\.tsdb\.cloud\.timescale\.com/.test(connectionString);
  if (isTigerCloud) {
    const caPath = process.env.TIGER_CA_CERT || TIMESCALE_CA_PATH;
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  const wantsSsl = /sslmode=(require|verify-ca|verify-full)/.test(connectionString);
  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    // Not a URL (e.g. key=value form): fall through to the explicit sslmode check.
  }
  return wantsSsl || (host !== '' && !LOCAL_HOSTS.has(host)) ? { rejectUnauthorized: true } : undefined;
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
