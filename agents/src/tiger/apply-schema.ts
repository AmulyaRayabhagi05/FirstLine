/** Apply db/tiger/schema.sql to TIGER_DATABASE_URL (or a pool you pass). Usage: npx tsx src/tiger/apply-schema.ts */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getPool, closePool, type Queryable } from './client.js';

export const SCHEMA_PATH = fileURLToPath(new URL('../../../db/tiger/schema.sql', import.meta.url));

export async function applySchema(db: Queryable = getPool()): Promise<void> {
  const sql = await readFile(SCHEMA_PATH, 'utf8');
  // Continuous aggregates cannot be created inside a transaction block, so run statement by statement.
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const stmt of statements) await db.query(stmt);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  applySchema()
    .then(() => console.log('[tiger] schema applied'))
    .catch((e) => { console.error('[tiger] schema failed:', e.message); process.exitCode = 1; })
    .finally(() => closePool());
}
