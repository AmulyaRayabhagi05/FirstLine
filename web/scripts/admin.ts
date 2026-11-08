// Creates the demo admin file, web/admin.local.json, so the dashboard opens already signed in.
//
//   cd web && npx tsx scripts/admin.ts
//
// It connects as a new SpacetimeDB identity and saves that identity's access key in the admin file.
// That identity still has to be staff to see household data. Either:
//   - run it with the module owner's token, and it grants staff itself:
//       SPACETIME_OWNER_TOKEN=<owner token> npx tsx scripts/admin.ts
//     (the owner token is the one the publisher's CLI uses: `spacetime login show --token`)
//   - or give the printed ID to the owner, who runs:
//       spacetime call --server maincloud firstline add_staff '"0x<ID>"'
//
// The admin file holds a key that can read every household's personal data. It is git-ignored and
// only read by the local dev server (`npm run dev`); production builds never include it.
// Running the script again keeps the same identity. Delete the file when the demo is over, and ask
// the owner to remove that staff row if the key may have leaked.

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConnection } from '../src/module_bindings/index';

const HOST = process.env.VITE_SPACETIME_HOST || readEnvLocal('VITE_SPACETIME_HOST') || 'https://maincloud.spacetimedb.com';
const DB = process.env.VITE_SPACETIME_DB || readEnvLocal('VITE_SPACETIME_DB') || 'firstline';
const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'admin.local.json');

function readEnvLocal(name: string): string | undefined {
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m?.[1].trim() || undefined;
}

function connect(token?: string): Promise<{ conn: DbConnection; identity: string; token: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${HOST} / ${DB}`)), 20_000);
    DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, tok) => {
        clearTimeout(timer);
        resolve({ conn, identity: identity.toHexString(), token: tok });
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(err);
      })
      .build();
  });
}

const existing = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as { accessKey?: string }) : null;
const admin = await connect(existing?.accessKey);
writeFileSync(
  FILE,
  JSON.stringify(
    {
      note: 'Demo admin login for the FirstLine dashboard. Secret: grants staff access to household data. Never commit or deploy this file.',
      host: HOST,
      database: DB,
      identity: `0x${admin.identity}`,
      accessKey: admin.token,
      createdAt: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(`${existing ? 'Kept' : 'Created'} admin identity 0x${admin.identity}`);
console.log(`Saved its access key to ${FILE}`);

const ownerToken = process.env.SPACETIME_OWNER_TOKEN;
if (ownerToken) {
  const owner = await connect(ownerToken);
  const { Identity } = await import('spacetimedb');
  await owner.conn.reducers.addStaff({ identity: Identity.fromString(admin.identity) });
  console.log('Granted staff with the owner token. The dashboard will open signed in.');
  owner.conn.disconnect();
} else {
  console.log('\nThis identity is not staff yet. Ask the database owner to run:');
  console.log(`  spacetime call --server maincloud ${DB} add_staff '"0x${admin.identity}"'`);
  console.log('or rerun this script with SPACETIME_OWNER_TOKEN set.');
}
admin.conn.disconnect();
process.exit(0);
