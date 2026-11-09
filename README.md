# FirstLine

**Your neighbors are the first line.** FirstLine turns neighbors into a live safety network for a
disaster, and tracks one number above everything else: how many people are still unknown.

- **Live dashboard:** https://207-148-5-196.sslip.io
- **Resident app (PWA):** https://207-148-5-196.sslip.io/app/
- **Devpost:** https://devpost.com/software/hope-qlvp96
- Built at **HackUTD 2026: ZeroDay** by Amulya Rayabhagi and Harshavarthan Mathapati.

## Why

In February 2021, Winter Storm Uri left 4.5 million Texas homes without power, and 246 people
died. Most were 60 or older, and many were alone at home, with a neighbor next door who never knew.
In the first hours of a disaster, 911 lines jam. During Hurricane Harvey, waits for high-water
rescue passed 20 hours.

The people who can actually reach someone in that window live on the same street. But nothing
tells them that the woman two doors down is 84, uses oxygen, has lost power and hasn't been heard
from since last night. FirstLine is the tool that tells them.

## What it does

- **Ask for help on any channel:**
  - The resident app.
  - SMS (`SOS`, `SAFE` or a short description).
  - A phone line where Nemotron answers. Callers press 1 or 2, or just speak.
  - Meshtastic LoRa mesh radio when cell towers are down.
- **Safety nets come first.** Each person names trusted neighbors or family, and their own people
  are asked first. A helper gets a call and presses 1 to accept or 2 to decline.
- **Finding the people who don't ask.** Plain, explainable rules score everyone:
  - no check-in,
  - power out,
  - freezing temperatures,
  - medical needs,
  - living alone,
  - no smartphone.

  A silent-signal agent sweeps the list and explains why each person should be checked on.
- **Triage: neighbor or responder.** Nemotron decides who should go:
  - A wellness check goes to a neighbor.
  - Someone trapped or in a medical emergency goes straight to responders.

  Declined or unanswered jobs are reassigned, and escalated if no one answers. Life-threat keywords
  ("can't breathe", "trapped", "water rising") force top priority, whatever the model says.
- **Confidence you can check.** Nemotron reported 0.90–0.95 on all 203 live triages, so
  FirstLine builds confidence from evidence it can verify instead:
  - Do the keyword rules agree?
  - Did the cited guidance actually come back from a lookup?
  - Was the profile read?
  - Do signals or a weather alert back it up?

  The model's own number counts for 15%. Below 0.7, a person calls or visits.
- **A live map for responders.** A 3D and 2D night map of Dallas where every home is a beam:
  - 🔴 unknown or needs help
  - 🔵 a helper is on the way
  - 🟢 checked in safe

  Hospitals, shelters and warming centers come from live feeds. Click a home for the household,
  its safety net and the agent's reasoning. The **Trace** page shows every case hop by hop.
- **Printable Priority 1 incident reports:**
  - **Per area:** Nemotron writes a briefing for each H3 neighborhood hexagon that has an open
    Priority 1 case.
  - **Per person:** the dashboard prints a one-page incident report for any P1 household, with the
    household and medical needs, Nemotron's triage, the helper and escalation, the full timeline,
    agent reasoning and the area briefing.
  - **From the dashboard:** use *Print incident report* on a household, or *Print this area* /
    *Print all areas* in the incident reports pop-up. All areas print one area per page, with its
    briefing, counts and P1 households.
- **Privacy by default.** Sign-up is opt-in, and phone numbers and health details are visible only
  to staff. The public view is read-only, and event data can be purged after the disaster.

## Resident app (PWA)

[`mobile/`](mobile/README.md) is the app residents use. It installs from the browser ("Add to Home
Screen") and lives at `/app/`.

- **Sign up** yourself or someone you care for, such as a parent without a smartphone. Each person
  enters:
  - age,
  - phone,
  - language,
  - whether they live alone,
  - mobility,
  - powered medical device,
  - medical needs,
  - home location (GPS or address).
- **One tap** for **"I'm safe"** or **"I need help"**. Both go through an outbox on the phone, so
  they send once the signal comes back and never twice.
- **Neighbor requests** show with directions. Tap "I'll go" or "I can't", then "They're safe".
- **Private by design.** The phone reads only its own rows through the `my_*` views, and no token
  ships in the build. The account is the phone.
- **Accessible:** English and Spanish, large type and big buttons, light and dark mode. It works
  offline once opened, because a service worker caches the app shell.

## How it works

```
 Resident app · SMS · voice · mesh radio
                 │  reducers
                 ▼
        SpacetimeDB (live state) ◀───── dashboard subscribes (no polling)
                 ▲  reducers only
                 │
   Agent worker (Node.js) ── Nemotron Nano 9B v2 on NVIDIA Brev (vLLM)
   triage · dispatch · silent signals · incident reports
                 │
        Tiger Data (TimescaleDB): history, trends, claim timelines
```

**Our rule throughout:** plain code wherever rules work, AI only where judgment is needed.

- **SpacetimeDB is the live state of the disaster.**
  - Every action is a reducer: SOS, check-in, assign, accept, decline, escalate, mark safe.
  - Scheduled reducers run the timers that reassign and escalate unanswered requests.
  - All tables are private. Clients read through role-scoped views (`ops_*` for staff, `my_*` for
    residents), and every reducer checks who is calling.
- **Four Nemotron agents,** each with its own tool allowlist:
  - **Triage** reads the SOS, looks up the profile and protocol guidance, and sets a priority.
  - **Dispatch** picks a neighbor or escalates, and replans when someone declines or times out.
  - **Silent signals** sweeps for people who haven't checked in and explains why each one matters.
  - **Incident reports** writes the P1 briefing for each neighborhood hexagon, and only rewrites it
    when something changed.

  Agents write back only through reducers, so every decision is a row and shows on the Trace page.
- **MCP server.** The agents' tools are also served read-only over MCP: 9 tools covering profile
  lookups, priority explanations, signals, case traces, open SOS and cell overviews.
  - Arguments are validated, slow calls time out, phone numbers are masked, result size is capped,
    and every call is audited.
  - Nothing that sends a message or writes a record is exposed.
- **Tiger Data** stores sensor readings, feed events and contact attempts in hypertables, with
  continuous aggregates (`cell_5m`, `person_last_contact`). The agents query it through SQL tools
  such as `at_risk_now`, `cell_trend` and `person_timeline`.

## Tech stack

| Area | Technology |
|---|---|
| Live database and backend | **SpacetimeDB** module in TypeScript (reducers, scheduled reducers, role-scoped views), on SpacetimeDB Maincloud |
| AI | **NVIDIA Nemotron Nano 9B v2**, served with **vLLM** on an **NVIDIA Brev** GPU instance (OpenAI-compatible API) |
| Agents | **Node.js / TypeScript** worker, four agents with tool allowlists, **zod**-validated tools, **MCP** server |
| History and trends | **Tiger Data** (TimescaleDB + PostGIS): hypertables, continuous aggregates |
| Dashboard | **React**, **Three.js** with **react-three-fiber**, **zustand**, **Vite** |
| Resident app | **React** PWA (service worker, offline outbox), **Vite** |
| Geography | **H3** hexagons (res 9 for neighbors, res 8 for briefings), OpenStreetMap geocoding |
| Messaging | **Twilio** SMS and voice (signed webhooks), **Meshtastic** LoRa mesh via an **MQTT** bridge |
| Live data feeds | National Weather Service alerts and forecasts, Open-Meteo, U.S. Census ACS, HHS emPOWER, FEMA open shelters, OpenStreetMap facilities, Dallas Police active calls |
| Hosting | **Vultr** server with **Caddy** (automatic HTTPS), systemd for the worker |
| Simulation | Seeded TypeScript simulator, **Vitest** tests |

## Does it work? The simulation

Our simulation (`sim/`) runs 5,000 synthetic Dallas residents through one Uri-like night, 5 seeds.
Its baseline is a calls-only response that is deliberately generous: 911 answers instantly and
triages perfectly.

| | Calls only | FirstLine |
|---|---|---|
| Critical cases reached within 1 hour | 13% | **62%** |
| Median minutes to the door | 101 | **41** |
| People who never asked, reached within 2 hours | 11% | **61%** |

Even when neighbors say yes half as often, FirstLine still reaches 47% within an hour. The model,
every assumption and the caveats are in [sim/README.md](sim/README.md).

## Repository layout

| Folder | What lives there |
|---|---|
| `server/` | SpacetimeDB module (TypeScript): tables, views, reducers and timers |
| `web/` | Responder dashboard: 3D/2D map, household cards, incident reports and printing, Trace page |
| `mobile/` | Resident app (PWA) |
| `agents/` | Node.js worker: the Nemotron agents, data feeds, Twilio, MCP server |
| `db/` | Tiger Data (TimescaleDB) schema: hypertables and continuous aggregates |
| `sim/` | Seeded simulator and the measurement in the table above |
| `deploy/` | Vultr and Caddy setup |
| `docs/` | Setup guides, demo script, security notes |

## Running it

- **Nemotron on Brev:** [docs/brev-setup.md](docs/brev-setup.md)
- **Database module:** [server/README.md](server/README.md)
- **Dashboard:** [web/README.md](web/README.md)
- **Resident app:** [mobile/README.md](mobile/README.md)
- **Hosting:** [deploy/vultr/README.md](deploy/vultr/README.md)
- **Demo walkthrough:** [docs/demo.md](docs/demo.md)

## Challenges we ran into

- **Our first database was fully public.** We rebuilt it with private tables, role-scoped views and
  caller checks on every reducer. A full security review closed 22 findings
  ([docs/security.md](docs/security.md)).
- **SOS text is an attack surface.**
  - Each agent has a strict tool allowlist, and public text is fenced as data in every prompt.
  - No agent can mark someone safe or unlock a home.
  - Life-threat keywords override the model.
- **Real Nemotron output broke our parser.** The agent loop now tolerates messy output, and the
  save tools are required.
- **Model confidence was meaningless,** so we replaced it with an evidence score we can explain.
- **We had to prove it works without a real disaster,** so we wrote down every assumption and
  measured the result.

## Secrets

This repo is public. Never commit keys, tokens or URLs with credentials. Real values go only in
`agents/.env` (git-ignored). Copy `agents/.env.example` to start.
