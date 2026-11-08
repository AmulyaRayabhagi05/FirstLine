# FirstLine: knowledge harness for Nemotron (handoff plan)

**State as of Nov 8, 2026.** The harness is on branch `feat/knowledge-harness` (from the latest `main`), wired into triage and the check-in call, with tests passing. The web map's live mode is on `feat/web-night-map`.

## Goal

Give the Nemotron agents a retrieval-based "harness" of official safety guidance and responder rules, so that:

- triage ranks emergencies the way trained responders do;
- every triage decision cites real guidance (CDC, FEMA/Ready.gov, Red Cross, NWS, FDA);
- the automated phone call reads short, cited safety lines.

**Why these topics.** Texas DSHS confirmed 246 Winter Storm Uri deaths:

- 158 hypothermia (64.2%)
- 19 carbon monoxide (7.7%), from generators, grills, heaters and cars
- deaths of people on life-sustaining electrical equipment

Frozen and burst pipes were the biggest insurance loss; State Farm paid about $343M in Texas.

**Fit with State Farm's track:**

| Topic | Why it fits |
|---|---|
| Carbon monoxide | Life safety; directly "most urgent needs" |
| Hypothermia | Life safety; directly "most urgent needs" |
| Water main shutoff | Loss prevention State Farm pays for |
| Flood | Life safety |
| Powered medical devices | Life safety |

All are kept.

## Done (on the branch)

### Web map (committed and pushed, `d531bf4`)

- **Live data.** The React map in `web/` reads the SpacetimeDB database `firstline` on Maincloud.
  - Homes are green when safe and red when they need help.
  - Start/Clear flood demo controls.
  - Mark household safe.
  - Resident profile tags.
- **Live database contents:**
  - 2,001 residents, loaded with the team's simulator via `web/scripts/live-store.ts`.
  - Everyone was checked in safe via `web/scripts/checkin-all.ts`.
  - A demo flood is currently active: 176 "needs help" check-ins.

### Knowledge harness (on `feat/knowledge-harness`)

Lives in `agents/src/knowledge/`.

| File | What it is |
|---|---|
| `types.ts` | `ProtocolCard` shape: id, hazard, severity, title, text, keywords, source, optional `say` (EN/ES). |
| `protocols.ts` | 37 cited cards plus `RESPONDER_RULES` (see below). |
| `retrieve.ts` | Retrieval: BM25 keyword search (offline), multilingual hazard cues, emergencies ranked first. |
| `embed.ts` | Optional NVIDIA embedding search, used when the embedding settings are filled in. |
| `harness.ts` | `lookup_protocol` agent tool, `spokenGuidance()` for calls, `retrieve()` blending keyword and embedding search. |

**The 37 cards** are paraphrased from pages that were opened and read:

- 7 carbon monoxide
- 7 hypothermia
- 5 water main / frozen pipes
- 5 flood
- 6 powered devices / insulin / dialysis
- 7 responder rules (CERT, START/SALT, welfare checks, Psychological First Aid)

**`RESPONDER_RULES`** is a priority order that goes into agent instructions:

0. Helper safety.
1. Immediate life threats → professionals (P1).
2. Silent high-risk people → welfare check, no forced entry (P2).
3. At-risk but responding.
4. Basic needs, then property.

**How retrieval ranks:**

- **Hazard cues.** English/Spanish/Vietnamese cues plus symptoms detect the hazard (e.g. "generador", "mareo", "agua entrando", "oxígeno").
- **Profile hazards.** The person's profile adds hazards too: a powered device, or age 65+ with no power.
- **Ranking.** Score = relevance × severity boost (life-threat 1.6, urgent 1.2, advice 1.0). Ties break toward life threats.
- **Embedding search (optional).** Set `EMBED_BASE_URL` (ending in `/v1`), `EMBED_MODEL` (e.g. `nvidia/llama-3.2-nv-embedqa-1b-v2`) and `EMBED_API_KEY` in `agents/.env`. Embedding scores are blended 50/50 with keyword scores. Any embedding error falls back to keyword search.
- **Typecheck:** clean.

**Spot checks (top 3 results):**

| Query | Top results |
|---|---|
| "generator in garage, my dad has a headache" | co-generator-outside, co-symptoms-911, co-no-indoor-burning |
| "agua entrando, mi mamá no puede caminar" | flood-trapped-high, flood-cannot-walk, flood-turn-around |
| "pipe burst water everywhere" | water-main-shutoff, water-frozen-signs, water-electric-hazard |
| "oxygen machine battery dying" | device-power-lost, device-safe-use, insulin-no-fridge |

## How it was wired (done)

### 1. Wire into triage (`agents/src/agents/triage.ts`)

1. Import `makeLookupProtocolTool` and `RESPONDER_RULES` from `../knowledge/harness.js`.
2. Add the tool to the `tools` array. Its profile callback maps `store.getPerson(sos.personId)` to `{ age, poweredDevice, medicalNeeds, mobility, livesAlone }`.
3. Append `RESPONDER_RULES` to `INSTRUCTIONS`, and change the steps line to:
   > `get_person_profile` → `lookup_protocol` (with the hazard you see) → `save_triage` whose `reason` cites 1–2 card ids in brackets, e.g. "Generator in garage + headache: possible CO [co-symptoms-911]".
4. Extend the offline `RULES`:
   - Generator/grill/heater/car **with** headache/dizzy/nausea/confusion → urgency 5, professional, "possible carbon monoxide".
   - Confused/slurred/very sleepy **with** cold/no heat → urgency 5, "hypothermia signs".
   - Pipe burst/leak → urgency 2, neighbor, "burst pipe".
   - In `ruleTriage`, append cited card ids to the reason: `searchProtocols(message, { k: 2, profile })`.
5. Do not change the `save_triage` schema or the reducer contract. Citations go in the `reason` string.

### 2. Wire into the phone call (`agents/src/messaging/voice.ts`)

1. In `SCRIPT.en.intro` / `SCRIPT.es.intro`, replace the hard-coded generator and device sentences with `spokenGuidance({ lang, profile, max: 2 }).join(' ')`. Keep the greeting and the "Press 1 / Press 2" prompt as is.
2. Pass the profile from `person` (it has `language`; add `poweredDevice` and `age` to `ChannelPerson` if missing).
3. Fix the winter wording: "Is your home too hot?" should become "Is your power out, or is your home too cold?" (Spanish: "¿Se fue la luz, o hace demasiado frío en su casa?").
4. TwiML text must stay XML-safe. Twilio's `say()` escapes it already; keep using `say()`.

### 3. Tests (vitest, `agents/src/knowledge/retrieve.test.ts`)

- **Retrieval:**
  - Each spot-check query above returns its expected first card.
  - A life-threat card outranks advice for a mixed query.
  - Spanish queries hit the same cards as English.
  - `detectHazards` picks up `powered_device` from a profile alone.
- **Triage:**
  - With the existing fake LLM (`src/llm/fake.ts`), the model path still saves.
  - `ruleTriage` gives P1 for "generator in the garage and grandma is dizzy".
- **Voice:**
  - `checkInTwiml` contains the 20-feet CO line for a default profile.
  - It contains the device line when `poweredDevice` is true.
- **Commands:** `npm test` and `npm run typecheck` in `agents/`.

### 4. Ship

1. Commit as the user (git identity is already set), with no AI attribution lines.
2. Push `feat/web-night-map`.
3. Open the PR into `main` at https://github.com/Spikestar05/FirstLine/pull/new/feat/web-night-map.
   - The GitHub CLI isn't installed on this machine.
   - The repo is private, so the browser must be signed in.
4. Add to `docs/contract.md`: the agent's `reason` may contain card ids in brackets; agents read the knowledge pack and never write to it.

## Notes on sources

- **Where sources differ, the cards follow the safer one:**
  - **CO:** get to fresh air, then call 911.
  - **Generators:** "at least 20 feet".
  - **Insulin:** FDA's 28 days at 59–86°F, not the "discard refrigerated medicine after a day" rule.
- **Weaker sources:**
  - **NIMS/ICS:** cited via Wikipedia, because the FEMA course pages were down.
  - **Welfare-check practice:** from one 911 center's SOP (Portland) plus a FireRescue1 article.
  - **SALT:** from an EMS1 article.
- **Copyright:** Red Cross and State Farm text is paraphrased. Government pages are public domain.
- **Responder research:** the full write-up with URLs is in the session transcript. Each card carries its URL.
