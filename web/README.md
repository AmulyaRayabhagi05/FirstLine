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
`firstline`).
Optional `VITE_SPACETIME_TOKEN` pins one identity so a dev dashboard stays staff when the port or
browser changes (otherwise every new origin gets a fresh identity that needs a grant). Local demos
only: `VITE_*` values ship in the bundle, so never set it on a public build.

The household card shows the latest Nemotron triage (`ops_triage`), the helper assignment and key
pass (`ops_assignment`, `ops_key_pass`), and a **Show reasoning** toggle with every
`ops_agent_step` row for that household (thoughts, tool calls, results, decisions). Full demo steps: [`../docs/demo.md`](../docs/demo.md).

Access: with `VITE_SPACETIME_TOKEN` set (the hosted build), visitors read as the public viewer and
see **Staff sign-in** to paste a staff access key; Mark safe and the flood controls appear only for
staff, and Sign out returns to the viewer. In `npm run dev`, `web/admin.local.json` (from
`npx tsx scripts/admin.ts`, git-ignored, never in a build) signs in as the demo admin. Point dev at
Maincloud with a git-ignored `web/.env.local` (`VITE_SPACETIME_HOST`, `VITE_SPACETIME_DB`).
