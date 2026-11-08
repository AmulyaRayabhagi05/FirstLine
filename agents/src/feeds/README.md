# feeds

Each module fetches one public feed and normalizes it to
`{ source, kind, time, h3_cells[], payload }` (H3 res 9, `payload.id` identifies the item).
`poller.ts` runs them on their intervals, writes to Tiger `feed_events`, and calls an optional
`onFeedEvent(event)` once per new event (use it to `set_cell_alert` / `set_cell_census`).

```ts
import { startPoller } from './feeds/poller.js';
startPoller({ onFeedEvent: async (e) => { if (e.source === 'nws_alerts') for (const c of e.h3_cells) await store.setCellAlert(c, String(e.payload.alert_level)); } });
```

CLI: `npx tsx src/feeds/poller.ts --once [--dry] [feed ...]` (dry run when `TIGER_DATABASE_URL` is unset).

| source | interval | endpoint | cells |
|---|---|---|---|
| `nws_alerts` | 2 min | `api.weather.gov/alerts/active?area=TX`, filtered to Dallas County (SAME 048113) | alert polygon, else Dallas County zone geometry (TXC113/TXZ119, cached 7 d) |
| `nws_forecast` | 30 min | `/points/32.7767,-96.797` then `forecastHourly` | downtown point; one event with the next 12 h |
| `fema_shelters` | 15 min | FEMA ESF6-SS `NSS/OpenShelters/MapServer/0`, Dallas bbox | shelter point |
| `hhs_empower` | daily | HHS emPOWER ArcGIS layer 1 (ZIP, all DME), `FIPS_Code='48113'` | ZIP polygon; `per_cell` spreads the count |
| `dallas_police` | 3 min | Socrata `9fxf-t2tr` (Dallas Police Active Calls) | beat centroid, else division centroid |
| `osm_facilities` | daily | Overpass: hospitals, fire and ambulance stations, cached 7 d | facility point |
| `census_acs` | daily | ACS 2023 5-yr S0101 65+ by tract (needs `CENSUS_API_KEY`) + TIGERweb tract shapes | tract polygon; `per_cell` estimate |
| `open_meteo` | 15 min | Open-Meteo current conditions, 3x3 grid over Dallas | grid point |

Notes:
- `d7e7-envw` is Dallas 311 service requests, not police calls; the police feed uses `9fxf-t2tr`.
  Calls have no coordinates, only a block/intersection, beat and division. Beat centroids come from
  the DPD "Beats3" ArcGIS layer (`data/dallas_beats.json`, 235 beats). Downtown 8xx beats are not
  in that layer and map to a Central Business District centroid.
- Static feeds (emPOWER, OSM, Census) land once per UTC day; FEMA shelters once per hour.
- Caches go to `FEEDS_CACHE_DIR` (default: OS temp dir `firstline-feeds-cache`).
- Fixtures in `agents/test/fixtures/` are real responses recorded 2026-11-08, except
  `census_s0101.json`, which is hand-written in the API's format (no key was available).
