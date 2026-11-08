// Seeded, dependency-free RNG so every run with the same seed gives the same world and storm.

/** FNV-1a string hash -> u32. Used to derive independent sub-streams from labels. */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private state: number;
  constructor(seed: number | string) {
    this.state = typeof seed === "string" ? hashStr(seed) : seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** mulberry32, uniform in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A new independent stream named `label`; consuming it does not shift this one. */
  fork(label: string): Rng {
    return new Rng(hashStr(`${this.state}:${label}`));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** Pick a key by weight. */
  weighted<T extends string>(weights: Readonly<Record<T, number>>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [k, w] of entries) {
      r -= w;
      if (r < 0) return k;
    }
    return entries[entries.length - 1][0];
  }
  /** Exponential with the given mean. */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }
  normal(mean = 0, sd = 1): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** Deterministic uniform [0,1) for a tuple of keys, independent of call order. */
export function hashUnit(...keys: (string | number)[]): number {
  return new Rng(hashStr(keys.join("|"))).next();
}
