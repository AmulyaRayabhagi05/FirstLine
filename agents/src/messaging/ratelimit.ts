// Fixed-window rate limit per sender (phone number or mesh node id), so one sender cannot flood
// the worker with SOS / check-in calls. Memory is bounded: the oldest senders are dropped.

export interface RateLimitOptions {
  /** Messages allowed per sender per window. */
  max: number;
  windowMs: number;
  /** Senders remembered at once (default 10,000). */
  maxKeys?: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly hits = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Counts one message from `key`; false when the sender is over the limit. */
  allow(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.start >= this.opts.windowMs) {
      this.hits.delete(key);
      this.hits.set(key, { start: t, count: 1 });
      this.trim();
      return true;
    }
    h.count++;
    return h.count <= this.opts.max;
  }

  private trim() {
    const max = this.opts.maxKeys ?? 10_000;
    while (this.hits.size > max) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }
}

/** Default inbound limit: 10 messages per sender per 10 minutes (env INBOUND_MAX_PER_10MIN). */
export function inboundLimiter(env: NodeJS.ProcessEnv = process.env): RateLimiter {
  const max = Number(env.INBOUND_MAX_PER_10MIN ?? 10);
  return new RateLimiter({ max: Number.isFinite(max) && max > 0 ? max : 10, windowMs: 10 * 60_000 });
}
