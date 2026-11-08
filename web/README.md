# web

React dashboard: a 3D/2D city of Dallas households, subscribed live to the FirstLine SpacetimeDB
module. Every home, status, agent decision and incident report on screen is a database row; there
is no hand-written data in the app.

```bash
npm install
npm run dev        # http://localhost:5173
```

- `src/data/live.ts` connects, subscribes to the staff `ops_*` views and builds what the map shows.
- `src/sim/world.ts` is only the city layout (river, roads, home footprints) and the projection
  from Dallas lat/lng onto it.
- The dashboard must be staff to see rows. Its identity is in the bottom bar ("Grant 0x...").

Settings: `VITE_SPACETIME_HOST` (default `http://127.0.0.1:3000`), `VITE_SPACETIME_DB` (default
`firstline`). Full demo steps: [`../docs/demo.md`](../docs/demo.md).
