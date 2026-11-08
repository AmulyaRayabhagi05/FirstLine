# Running the demo

The demo is the real system running locally: the SpacetimeDB module, the Nemotron agent worker
with the live Dallas feeds, and the web dashboard. The residents are synthetic (the seeded sim in
`sim/`), so the same seed gives the same 1,000 Dallas residents and the same storm night every run.
Nothing in the dashboard is hand-written: every home, status, agent decision and incident report on
screen is a row in the database.

## What is live and what is synthetic

| Piece | Source |
|---|---|
| Residents, households, safety nets | `sim/` generator, 5 real Dallas neighborhoods (North Oak Cliff, Pleasant Grove, Lakewood, Vickery Meadow, West Dallas), loaded through the module's reducers |
| The storm night (power outages, check-ins, SOS messages) | `sim/` storm, played into the database at N x speed |
| Triage, dispatch, silent-signal and incident-report decisions | Nemotron agents in `agents/`, live, against the database |
| Weather and road context | Live feeds polled by the worker: NWS alerts and forecast, Open-Meteo, Dallas Police active calls, FEMA shelters, HHS emPOWER, OSM facilities |
| Geofence | `update_location` logs `geofence_entered` when a person enters a cell with an alert |

Outbound SMS and calls are off in the demo (`scripts/demo-worker.sh` blanks `TWILIO_*`): the
residents' phone numbers are fake. The worker logs `[comms:stub]` lines instead.

## One-time setup

```bash
spacetime start                         # terminal 1, keep running
npm install --prefix server
npm install --prefix sim
npm install --prefix agents
npm install --prefix web
```

`agents/.env` must have the Nemotron endpoint (`NEMOTRON_*`); Tiger Data is optional.

## Before each demo

1. Start the dashboard and copy its identity from the bottom bar ("Grant 0x...").

   ```bash
   npm --prefix web run dev
   ```

2. Reset the database, grant roles (including the dashboard), and seed the residents:

   ```bash
   scripts/demo-reset.sh 0x<dashboard identity>
   ```

3. Start the worker (terminal 2, keep running):

   ```bash
   scripts/demo-worker.sh
   ```

4. Reload the dashboard. The bottom bar should read **Live · 1000 people**.

## During the demo

Play the night (terminal 3). At the default speed it takes three minutes:

```bash
scripts/demo-storm.sh
```

`SPEED=120` doubles the length; `FROM=60 TO=360` plays part of the night. Use **▶ Tour** in the
dashboard for the camera sweep, click a home for its household card and agent log, and watch the
incident reports panel fill in as the reports agent writes them.

## Settings

| Variable | Used by | Default |
|---|---|---|
| `DB` | all scripts | `firstline` |
| `N`, `SEED` | reset, storm | `1000`, `20210214` |
| `SPEED`, `FROM`, `TO` | storm | `240`, whole night |
| `VITE_SPACETIME_HOST`, `VITE_SPACETIME_DB` | web | `http://127.0.0.1:3000`, `firstline` |
