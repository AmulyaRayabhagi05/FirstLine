// Optional dense retrieval with an NVIDIA embedding model over an OpenAI-compatible /embeddings API
// (for example nvidia/llama-3.2-nv-embedqa-1b-v2 on build.nvidia.com, or a NIM on Brev).
// Set EMBED_BASE_URL (ending in /v1), EMBED_MODEL and, if needed, EMBED_API_KEY in agents/.env.
// Without them, retrieval stays BM25-only.

import { PROTOCOLS } from './protocols.js';

export interface EmbedConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export function embedConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmbedConfig | null {
  const baseUrl = (env.EMBED_BASE_URL ?? '').replace(/\/+$/, '');
  const model = env.EMBED_MODEL ?? '';
  if (!baseUrl || !model) return null;
  return { baseUrl, model, apiKey: env.EMBED_API_KEY ?? env.NEMOTRON_API_KEY ?? '' };
}

async function embed(cfg: EmbedConfig, input: string[], inputType: 'query' | 'passage'): Promise<number[][]> {
  const res = await fetch(`${cfg.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    // input_type is what NVIDIA retrieval embedders expect; other servers ignore it.
    body: JSON.stringify({ model: cfg.model, input, input_type: inputType, encoding_format: 'float' }),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data.map((d) => d.embedding);
}

const cos = (a: number[], b: number[]) => {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na * nb) || 1);
};

/** Embeds the pack once, then scores queries against it. Any failure returns null so callers fall back to BM25. */
export class DenseIndex {
  private vecs: number[][] | null = null;
  constructor(private cfg: EmbedConfig) {}

  async scores(query: string): Promise<Map<string, number> | null> {
    try {
      if (!this.vecs) this.vecs = await embed(this.cfg, PROTOCOLS.map((c) => `${c.title}. ${c.text}`), 'passage');
      const [q] = await embed(this.cfg, [query], 'query');
      const sims = this.vecs.map((v) => cos(q, v));
      const lo = Math.min(...sims);
      const hi = Math.max(...sims);
      return new Map(PROTOCOLS.map((c, i) => [c.id, (sims[i] - lo) / (hi - lo || 1)]));
    } catch (err) {
      console.error('[knowledge] embedding search failed, using keywords only:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}
