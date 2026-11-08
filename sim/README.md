# sim

Synthetic Dallas residents, one Uri-like winter-storm night, loaders into SpacetimeDB and Tiger
Data, and a measurement that compares FirstLine with a calls-only baseline over the same storm.
Everything is seeded: the same seed gives byte-identical output.

```bash
cd sim
npm install
npm run seed      # world + storm -> out/*.json (git-ignored)
npm run storm     # dry run: counts every reducer call and Tiger row
npm run measure   # FirstLine vs calls-only, 5 seeds, prints the numbers for the writeup
npm test
```

Options: `npm run seed -- --n 5000 --seed 20210214`, `npm run measure -- --seeds 5`.

## Files

| File | What |
|---|---|
| `src/generate.ts` | 5,000 residents (default) in 5 real Dallas neighborhoods: North Oak Cliff, Pleasant Grove, Lakewood, Vickery Meadow, West Dallas. Households with addresses, ages (more 65+ in Lakewood and around senior complexes), lives alone, mobility, oxygen / insulin / dialysis, powered devices, phone type, language (en / es / vi), fake phones, safety nets. |
| `src/storm.ts` | The night (8 pm to 8 am): outdoor temperature, outages spreading by neighborhood, indoor temperature per home, phones dying, check-ins, SOS messages, helper behavior, real-time or N x playback. |
| `src/messages.ts` | SOS free text in English, Spanish and some Vietnamese. |
| `src/loaders/types.ts` | `SimStore`: the subset of the worker's `FirstLineStore` the sim writes through (`registerPerson`, `setSafetyNet`, `pressSos`, `checkIn`, `reportSignal`, same signatures). |
| `src/loaders/spacetime.ts` | `loadWorld`, `applyEvent`, `playIntoStore`, and `startHelperBot` (answers offered assignments the way each helper's profile says). |
| `src/loaders/tiger.ts` | `readings` (`home_temp_f`, `power_out`, `phone_offline_min`) and `contact_events` rows via `pg` from `TIGER_DATABASE_URL`; skipped if unset. |
| `src/loaders/dryrun.ts` | Counts calls. |
| `src/measure.ts` | The comparison model below. |

## Demo characters (always ids 1 to 5, same blocks of N Tyler St, North Oak Cliff)

| id | Who | Script |
|---|---|---|
| 1 | Rosa Martinez, 34, Spanish | Sends the SOS at 10:30 pm (t+150 min): "Se fue la luz y hace mucho frío. Mi mamá no puede caminar y no tenemos calefacción. Por favor ayuda." |
| 2 | Carmen Martinez, 71, Rosa's mother, cannot walk, insulin | Critical (cold house) from t+140. |
| 3 | Marcus Johnson, 42, truck | First in Rosa's ring 1. Never answers: the offer times out after 10 min. |
| 4 | Thomas Lee ("Mr. Lee"), 84, alone, oxygen, cordless landline | Power and phone die at 9:30 pm, oxygen backup runs out ~11 pm. Never sends an SOS: only the silent-signal sweep can find him. |
| 5 | Linh Tran, 29, Vietnamese, truck + generator | Second in Rosa's ring 1. Always accepts. |

The power goes out on their blocks at t+90 (9:30 pm).

## Running against the real stack

- **SpacetimeDB**: `SIM_STORE_MODULE=path/to/store.ts npm run storm -- --target spacetime --speed 60 --helpers`.
  The module must export `createStore(): Promise<SimStore>`; a wrapper around the worker's
  SpacetimeDB `FirstLineStore` fits as is. `--speed 60` plays one storm hour per minute
  (12-minute demo); `--from 120 --to 240` plays a slice; `--no-register` skips loading people.
  Note: `register_person` creates one household per call, so multi-person sim households become
  separate households in the module (same address).
- **Tiger**: `TIGER_DATABASE_URL=... npm run storm -- --target tiger --end-now --clear` writes
  ~136k readings and ~5k contact events, shifted so the night ends now.

## Measurement model

The question: during a storm night, how quickly does someone get to the door of each person who
is in real danger? It is a minute-stepped simulation over the same world and storm for both
strategies. Numbers come from a model with stated assumptions, not field data.

### Ground truth (what really happens; the live system never sees it)

- **Weather**: 24 °F at 8 pm falling to 3 °F before dawn (Feb 15, 2021 in Dallas reached -2 °F).
- **Outages**: 72% of H3 res-8 areas lose power, each neighborhood starting at a random time
  between 8:30 pm and midnight with exponential spread (mean 100 min). No restoration overnight.
  20% of outage areas also lose cell towers 3 to 5 h later (tower battery backup).
- **Indoor temperature**: 68 °F, then Newton cooling toward outdoor with a per-home time constant
  of 9 to 22 h.
- **Phones**: cordless landlines die with the power. Mobile phones run 35 to 100% battery at
  7 to 12%/h (smartphones) or 4%/h (feature phones), or die when the tower does.
- **Critical** means "needs someone in person tonight":
  - frail (cannot walk, 80+, or 70+ and alone or limited mobility) and the home falls below
    52 °F (54 °F if they cannot walk): 55% of them become critical;
  - home oxygen: 30 min to 4 h after the power goes out (backup tank);
  - home dialysis: 5 to 8 h after the power goes out (missed session, needs transport);
  - carbon monoxide from cars, grills or generators used for heat: 0.15% of people without power
    (a leading cause of death in Uri);
  - falls in the dark: 1.2% of 70+ without power.
  About 3.6% of residents per storm (178 of 5,000 on average). That is "someone should come",
  not "will die".
- **Who asks for help**: 25 min (mean) after onset, the person sends an SOS if their phone works,
  they are not incapacitated (70% of CO, 30% of falls are) and they choose to (75%; 45% for 75+
  living alone). Otherwise another household member with a working phone sends it (85%). The
  rest are **silent**: about 47% of critical cases. Plus ~1.5% of other people without power send
  non-urgent SOS (supplies, burst pipes, rides, worried relatives) that triage has to sort out.

### Both strategies

- **EMS**: 3 units for this 5,000-person area (Dallas has roughly one ambulance per 20,000
  people, so this is generous), 35 ± 10 min to drive on ice, busy 60 min after arriving. P1 first.
- **Informal help** (no app needed, same in both): 50% of people who ask for help also phone
  family or a neighbor who arrives 10 + exp(60) min later; 25% of silent cases get an unprompted
  visit, exp(240) min after onset.
- **Third-party 911 calls**: 30% of silent cases, exp(120) min after onset.

### Calls-only baseline

Everyone who would press SOS calls 911 instead. Generous on purpose: calls are answered
instantly, call-takers triage perfectly, and non-urgent calls go to 311 without using a unit.

### FirstLine

- **Triage**: 1 min; 15% of real emergencies are misread as non-urgent (P3: rings 1 and 2 only,
  no EMS call or escalation; the silent-signal sweep can still catch them later). 10% of non-urgent
  requests are over-rated to P2. Emergencies that need professionals (CO, falls, dialysis) also go
  to EMS straight away. By default P3 requests are offered to neighbors at once
  (`p3DelayMin: 0`); see Sensitivity for a 60-minute hold.
- **Dispatch**: offers go one at a time to the person's ring 1 (closest first), ring 2, then
  the 6 nearest able adults around them (ring 3). Each helper answers per their profile:
  accept (mean 50%), decline (mean 20%), or no answer (10-min timeout, per the contract). Answer
  delay averages 2 to 8 min. Dispatch skips helpers who are busy or whose app stopped reporting;
  helpers whose phone actually died or who are in trouble themselves never answer. A helper
  walks at 3 km/h or drives a truck at 12 km/h after 5 min to get ready, then is busy 45 min.
  If every candidate fails, P1 and P2 requests go to EMS.
- **Silent-signal sweep** every 15 min: a priority score from observable data only
  (`vulnerability x exposure x contact gap`: age, alone, oxygen or powered device, mobility,
  smartphone, language; outage feed, smart-thermostat low-temp signal; minutes since contact,
  failed calls, app heartbeat lost). Score >= 10 gets an automated check-in call (at most hourly).
  It is answered 85% of the time if the phone works (60% if they are in trouble, never after CO or
  a fall). Score >= 14 and no answer sends a neighbor check (max 25 new checks per sweep).
- In-app check-ins from FirstLine pings (9 pm, midnight, 4 am) count as contact; a
  `needs_help` reply is handled like an SOS.

### What is counted

A critical case is **reached** at the first in-person arrival (neighbor, relative or EMS) at or
after onset. Visits before onset do not count, even if they would have prevented the emergency.
The run continues 3 h past 8 am so late cases can finish.

## Results (`npm run measure`, 5 seeds x 5,000 residents)

Mean across seeds, min to max in brackets.

| | Calls only | FirstLine |
|---|---|---|
| Critical reached within 30 min | 4% (2-6) | 30% (25-33) |
| Critical reached within 60 min | 13% (10-16) | 62% (58-67) |
| Critical reached within 120 min | 25% (21-32) | 80% (75-86) |
| Critical reached by 11 am | 43% (39-51) | 87% (83-90) |
| Silent critical reached within 120 min | 11% (5-15) | 61% (53-75) |
| Silent critical reached by 11 am | 24% (20-28) | 74% (66-81) |
| Median minutes, onset to someone at the door | 101 | 41 |

The cost per storm in FirstLine: about 10,700 automated check-in calls, 930 neighbor checks
(about 1 in 7 finds a critical case), 2,400 helper offers (940 accepted, 1,100 timed out).

Sensitivity (calls only -> FirstLine, same 5 storms, one change per row):

| Change | Reached within 60 min | Reached by 11 am |
|---|---|---|
| Defaults | 13% -> 62% | 43% -> 87% |
| Neighbors accept half as often | 13% -> 47% | 43% -> 80% |
| 2 EMS units instead of 3 | 13% -> 62% | 40% -> 87% |
| 6 EMS units instead of 3 | 15% -> 62% | 48% -> 88% |
| No third-party 911 calls | 13% -> 62% | 42% -> 86% |
| Triage misses 40% of emergencies | 13% -> 62% | 43% -> 87% |
| Non-urgent (P3) requests wait 60 min | 13% -> 60% | 43% -> 87% |
| P3 waits 60 min + triage misses 40% | 13% -> 54% | 43% -> 87% |

Every option is wired into the model; a test (`every sensitivity knob reaches the model`)
checks this. Some rows barely move FirstLine's number, for these reasons:

- **EMS units and third-party 911 calls.** Both feed only the EMS queue. In FirstLine runs a
  neighbor or relative gets there first in 99% of reached cases (EMS first in 6 of 888 over 5
  storms), so EMS capacity changes who EMS reaches but rarely the first arrival. It does move the
  calls-only baseline (13% to 15% within 60 min, 40% to 48% by morning), because there EMS is the
  main responder. At 35 min of driving plus queueing, EMS seldom arrives within an hour of onset.
- **Triage misses.** A missed emergency is read as non-urgent (P3: supplies or a ride): no ring 3,
  no parallel EMS call, no escalation. With the default policy every request, P3 included, is
  offered to neighbors at once. In that case the person's own ring 1 and 2 usually cover it, and
  helpers are rarely all busy at the same time, so priority hardly matters (even a 100% miss rate
  costs about 1 point). Triage starts to matter as soon as the dispatcher holds back non-urgent
  requests: with a 60-minute P3 hold, raising misses from 15% to 40% drops the 60-minute rate from
  60% to 54%. Which policy the real dispatch agent uses decides how much triage accuracy matters.

Read this honestly:

- The gain comes from capacity and proximity: thousands of neighbors a few hundred meters away
  versus a few EMS units on icy roads. It is most sensitive to how often neighbors say yes.
- The population, the storm, who becomes critical, and helper behavior are all synthetic and set by
  the rules above. The model has no blocked roads, no helpers getting hurt, and no people refusing
  a visit.

Suggested writeup line: *"In a simulated Uri-like night over 5,000 synthetic Dallas residents
(5 seeds), FirstLine got someone to the door of 62% of critical cases within an hour, against 13%
for a calls-only baseline, and found 61% of the people who never asked for help within two hours,
against 11%. Model and assumptions: sim/README.md."*
