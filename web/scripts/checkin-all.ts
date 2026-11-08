// Checks in every person whose status is still `unknown` as safe, so a calm night starts all green.
// Reads ops_person, so the connecting identity must be staff (or the worker); check_in also needs it.
// Usage (from agents/): npx tsx ../web/scripts/checkin-all.ts
import { SpacetimeStore, spacetimeConfigFromEnv } from '../../agents/src/store/spacetime';

const store = await SpacetimeStore.connect(spacetimeConfigFromEnv());
const people = [...store.conn.db.opsPerson.iter()].filter((p) => p.status === 'unknown');
console.log(`checking in ${people.length} people as safe`);
let done = 0;
for (const p of people) {
  await store.conn.reducers.checkIn({ clientId: `calm-${p.id}`, personId: p.id, kind: 'app', result: 'safe', note: 'start of night' });
  if (++done % 250 === 0) console.log(`  ${done}/${people.length}`);
}
console.log('done');
store.disconnect();
process.exit(0);
