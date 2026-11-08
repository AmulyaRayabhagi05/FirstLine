# messaging

How messages reach FirstLine when the app can't: SMS to a Twilio number, automated check-in
phone calls, and Meshtastic LoRa radios relayed through an MQTT broker. Every inbound message
ends as a contract reducer call (`press_sos`, `check_in`, `log_agent_step`) through
`ChannelStore` (`store.ts`), which the coordinator maps onto `FirstLineStore` at merge.

| File | What it does |
|---|---|
| `store.ts` | `ChannelStore` (`pressSos`, `checkIn`, `logAgentStep`, `findPersonByPhone`) + `InMemoryChannelStore` fake |
| `parse.ts` | Compact text format shared by SMS and mesh |
| `inbound.ts` | Parsed text -> reducer call + reply |
| `twilio.ts` | Twilio client interface + mock, signature check, `send_sms` tool |
| `voice.ts` | `placeCheckInCall`, `place_check_in_call` tool, call webhooks |
| `server.ts` | `node:http` server for the Twilio webhooks |
| `meshtastic-bridge.ts` | MQTT bridge, `mesh_send_text` tool |
| `main.ts` | Standalone runner (in-memory store) |

## Text format (SMS and mesh)

```
FL SOS 32.78,-96.80 2ppl insulin    SOS with location, head count and note
FL SOS water rising                  SOS; location from the sender's last known position
FL OK                                check-in: safe
FL HELP need a ride to dialysis      SOS with free-text need
FL OK #14                            #<personId> names the person (shared phones, radios)
```

Case and spacing don't matter. Spanish verbs work too (`SOCORRO`, `AUXILIO`, `AYUDA`, `BIEN`).
Text without the `FL` prefix from a registered phone (or a mapped radio) is treated as an SOS
and its text goes to triage as-is, in any language. Free text from an unknown number gets a
reply explaining the format and creates nothing. A `FL SOS` from an unknown sender still
creates an SOS with `person_id = 0` (unregistered) so it is never dropped.

Idempotency: `client_id` is `sms:<MessageSid>`, `voice:<CallSid>` or
`mesh:<!nodeId>:<packetId>`, so Twilio retries and packets heard by several gateways create
one row.

## Environment

All from env (`agents/.env`), nothing in the repo.

| Var | Used for |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | REST calls; the token also turns on webhook signature checks. Without them a `MockTwilio` logs instead of sending. |
| `TWILIO_FROM_NUMBER` | Number SMS and calls come from |
| `PUBLIC_BASE_URL` | Public URL Twilio reaches, e.g. `https://abc.ngrok.app` (call webhooks + signature URL) |
| `MESSAGING_PORT` | Webhook server port, default `8787` |
| `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` | Broker the Meshtastic gateway publishes to |
| `MESH_ROOT_TOPIC` | Default `msh/US` |
| `MESH_GATEWAY_NODE` | Gateway node id (`!7efeee00` or decimal); needed for downlink replies |
| `MESH_CHANNEL_INDEX` | Channel index for downlinks (optional) |
| `MESH_NODE_MAP` | Demo radio-to-person map, `!a1b2c3d4=14,!0000beef=22` |
| `DEMO_PHONE` | `main.ts` only: registers this phone as person 1 in the in-memory store |

## Run it

```bash
cd agents
npx tsx src/messaging/main.ts
```

Tests: `npx vitest run src/messaging`.

## Point Twilio at it

1. Expose the server: `ngrok http 8787`, then set `PUBLIC_BASE_URL` to the https URL.
2. Twilio Console > Phone Numbers > your number > Messaging: "A message comes in" = Webhook,
   `POST https://<PUBLIC_BASE_URL>/sms`.
3. Voice needs no number config: `placeCheckInCall` sends the TwiML inline and points the
   Gather action at `/voice/result` and the status callback at `/voice/status`.
4. Set `TWILIO_AUTH_TOKEN` so every webhook is signature-checked (403 otherwise). The check
   uses `PUBLIC_BASE_URL` + path because ngrok rewrites the Host header.
5. Trial accounts can only text and call verified numbers, and prepend a trial notice.
   Test credentials (`ACxxx` test SID + test token, from `+15005550006`) exercise the REST
   calls without sending anything.

Call flow: script asks about heat / power, generator carbon monoxide and powered medical
devices, then "press 1 if okay, 2 if you need help, or tell us". 1 -> `check_in(voice, safe)`;
2 -> `press_sos(voice)` at the person's last location; speech -> `classifyReply(text, lang)`
(inject the worker's Nemotron classifier; `keywordClassifyReply` is the stub), unclear speech
is asked once more and then escalated as an SOS; silence, busy or no pickup ->
`check_in(voice, no_answer)`. Spanish speakers (`person.language` starting with `es`) get a
Spanish script and Spanish speech recognition.

## Point the Meshtastic gateway at it

On the radio that has Wi-Fi (ESP32 board; nRF52 boards can't do JSON MQTT), via the app or CLI:

1. MQTT module: enabled, broker address/user/password = your broker, **JSON enabled**,
   root topic left as default (`msh/US`) or matching `MESH_ROOT_TOPIC`.
2. Primary channel (e.g. LongFast): **uplink enabled**.
3. For replies and `mesh_send_text`: add a channel named exactly `mqtt` with **downlink
   enabled** (any PSK), reboot, and set `MESH_GATEWAY_NODE` to this node's id.
4. Any broker works (Mosquitto locally: `mosquitto -v`, then `MQTT_URL=mqtt://localhost:1883`).

The bridge subscribes to `<root>/2/json/+/+`, reads `type: "text"` (`payload.text`) and
`type: "position"` (`payload.latitude_i/longitude_i`, degrees x 1e7) packets, de-dupes by
`from` + `id`, and replies with a short DM. Downlinks go to `<root>/2/json/mqtt/` as
`{ "from": <gateway>, "to": <node>, "type": "sendtext", "payload": "check on #14" }`.
Chatter from unknown radios that doesn't start with `FL` is ignored (no reply loops).

Test without radios by publishing a fake uplink:

```bash
mosquitto_pub -t msh/US/2/json/LongFast/!7efeee00 -m '{"id":1,"from":2712847316,"type":"text","payload":{"text":"FL SOS 32.78,-96.80 2ppl insulin"}}'
```

## Agent tools

`makeSendSmsTool`, `makePlaceCheckInCallTool`, `makeMeshSendTool` each return
`{ name, description, inputSchema (zod), run }`.

## Merge notes

- `ChannelStore` methods match the contract reducers; `findPersonByPhone` is a read the worker's
  `FirstLineStore` needs to add (or the adapter can scan `person` by `phone`).
- `person_id = 0` marks an SOS from an unregistered sender.
- `.env.example` (outside this folder) should gain `PUBLIC_BASE_URL`, `MESSAGING_PORT` and the
  `MESH_*` vars above.
