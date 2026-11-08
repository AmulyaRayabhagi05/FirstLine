// Minimal OpenAI-compatible chat client over fetch (vLLM serving Nemotron on Brev).

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** "fast" (default) or "plan": picks NEMOTRON_FAST_MODEL or NEMOTRON_PLAN_MODEL. */
  tier?: "fast" | "plan";
  temperature?: number;
  maxTokens?: number;
  /** Which agent is calling; real clients ignore it, fakes use it to route scripted replies. */
  tag?: string;
}

export interface ChatResult {
  content: string;
  model: string;
}

export interface LlmClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  fastModel: string;
  planModel: string;
  timeoutMs: number;
  retries: number;
}

export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.NEMOTRON_BASE_URL ?? "").replace(/\/+$/, "");
  const fastModel = env.NEMOTRON_FAST_MODEL ?? "";
  if (!baseUrl || !fastModel) {
    throw new Error("NEMOTRON_BASE_URL and NEMOTRON_FAST_MODEL must be set (see agents/.env.example)");
  }
  return {
    baseUrl,
    apiKey: env.NEMOTRON_API_KEY ?? "",
    fastModel,
    planModel: env.NEMOTRON_PLAN_MODEL || fastModel,
    timeoutMs: Number(env.NEMOTRON_TIMEOUT_MS ?? 60_000),
    retries: Number(env.NEMOTRON_RETRIES ?? 2),
  };
}

export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAICompatClient implements LlmClient {
  constructor(private readonly cfg: LlmConfig) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.tier === "plan" ? this.cfg.planModel : this.cfg.fastModel;
    const body = JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
    });
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      try {
        const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new LlmHttpError(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
          // 4xx other than 408/429 will not get better on retry.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw err;
          lastErr = err;
          continue;
        }
        const json = (await res.json()) as {
          model?: string;
          choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
        };
        const content = json.choices?.[0]?.message?.content ?? "";
        return { content, model: json.model ?? model };
      } catch (err) {
        if (err instanceof LlmHttpError && err.status && err.status < 500 && err.status !== 408 && err.status !== 429) {
          throw err;
        }
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
