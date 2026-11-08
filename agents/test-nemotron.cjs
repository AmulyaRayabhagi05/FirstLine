// Smoke test: send one chat request to the Nemotron endpoint and print the reply.
// Run from agents/:  node test-nemotron.cjs
// Reads agents/.env (NEMOTRON_BASE_URL, NEMOTRON_API_KEY, NEMOTRON_FAST_MODEL).
// Needs Node 21+ (built-in fetch and process.loadEnvFile). No npm packages.

const path = require("node:path");

try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {
  console.error("Missing agents/.env. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const { NEMOTRON_BASE_URL, NEMOTRON_API_KEY, NEMOTRON_FAST_MODEL } = process.env;
for (const [name, value] of Object.entries({ NEMOTRON_BASE_URL, NEMOTRON_FAST_MODEL })) {
  if (!value) {
    console.error(`${name} is empty in agents/.env`);
    process.exit(1);
  }
}

async function main() {
  const url = `${NEMOTRON_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model: NEMOTRON_FAST_MODEL,
    messages: [
      { role: "system", content: "/no_think" }, // fast mode: skip the reasoning trace
      { role: "user", content: "Reply with OK and your model name" },
    ],
    max_tokens: 64,
    temperature: 0,
  };

  const started = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(NEMOTRON_API_KEY ? { Authorization: `Bearer ${NEMOTRON_API_KEY}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const ms = Math.round(performance.now() - started);

  if (!res.ok) {
    console.error(`HTTP ${res.status} from ${url}\n${await res.text()}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(`Model:    ${data.model}`);
  console.log(`Reply:    ${data.choices?.[0]?.message?.content?.trim()}`);
  console.log(`Time:     ${ms} ms`);
  if (data.usage) {
    console.log(`Tokens:   ${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out`);
  }
}

main().catch((err) => {
  console.error(`Request failed: ${err.message}`);
  console.error("Is the endpoint up? Check `brev ls` and that port-forward is running.");
  process.exit(1);
});
