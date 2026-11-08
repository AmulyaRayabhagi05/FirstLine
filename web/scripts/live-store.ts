// SimStore for the sim's `npm run storm -- --target spacetime`: the agent worker's SpacetimeDB adapter.
// Usage (from sim/): SIM_STORE_MODULE=../web/scripts/live-store.ts npx tsx src/cli/storm.ts --target spacetime --n 2000 --to 0
import { SpacetimeStore, spacetimeConfigFromEnv } from '../../agents/src/store/spacetime';

export async function createStore() {
  return SpacetimeStore.connect(spacetimeConfigFromEnv());
}
