# agents

Node.js worker that runs the Nemotron agents (multi-step triage and planning with tool use).
It talks to the model through an OpenAI-compatible endpoint (`/v1/chat/completions`).

## Setup

1. Copy `.env.example` to `.env` and fill in the values. `.env` is git-ignored; never commit it.
2. Make sure the model endpoint is up (see `../docs/brev-setup.md`).

## MCP server

The read-only FirstLine tools are also served over MCP (`src/mcp/`), built from the same `defineTool()`
definitions the agents call, so any MCP client sees exactly what the agents see.

```bash
cd agents && npm run mcp                         # in-memory demo store unless SPACETIME_DB_NAME is set
claude mcp add firstline -- npm --prefix agents run -s mcp
```

Tools: `lookup_protocol`, `get_person_profile`, `explain_priority`, `get_signals`, `get_history`,
`get_case_trace`, `list_open_sos`, `check_message`, `get_cell_overview`. Nothing that sends a message,
offers a helper or writes a record is exposed; those stay in the worker behind reducers.

Each tool goes through a wrapper (`src/mcp/wrap.ts`) that validates arguments with the tool's zod
schema, times out slow calls, masks phone numbers, caps result size and writes an audit line per call.

The agents themselves still call their tools in-process: an MCP hop on every step would add latency
and a second process to the triage path without changing what the model can do.

## Confidence

Saved triage confidence and the silent-signal guard use `src/agents/confidence.ts`, computed from
checks we can verify (rules agree, citations real, profile read, signals and weather back it up).
The model's own number counts for 15%. The breakdown is logged as a decision step, e.g.
`Confidence 0.80 from evidence: ✓ keyword rules agree on P1 · ✓ cited [flood-trapped-high] ... · ✗ no sensor or weather data`.
