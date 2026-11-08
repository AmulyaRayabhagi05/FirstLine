// Retrieval over the protocol pack.
//
// - BM25 keyword search: no network, deterministic, works when the model is down.
// - Optional dense search with an NVIDIA embedding model (OpenAI-compatible /embeddings), blended in
//   when EMBED_BASE_URL and EMBED_MODEL are set.
// - Emergencies first: life-threat cards get a boost, and hazards detected in the message or the
//   person's profile pull their cards in even if the words don't match.

import { PROTOCOLS } from './protocols.js';
import type { Hazard, ProtocolCard, RetrievedCard, Severity } from './types.js';

const STOP = new Set('a an the and or of to in on for is are be at by it if you your with from as that this not do does can have has was were will just get when what how la el de en y o que un una los las por con se su es no'.split(' '));

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

const docText = (c: ProtocolCard) => [c.title, c.text, c.keywords.join(' '), c.hazard.replace('_', ' ')].join(' ');

class Bm25 {
  private docs: string[][];
  private df = new Map<string, number>();
  private avg: number;
  constructor(texts: string[], private k1 = 1.4, private b = 0.75) {
    this.docs = texts.map(tokenize);
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avg = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }
  scores(query: string): number[] {
    const q = tokenize(query);
    const N = this.docs.length;
    return this.docs.map((d) => {
      let s = 0;
      for (const t of q) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avg)));
      }
      return s;
    });
  }
}

const index = new Bm25(PROTOCOLS.map(docText));

// Hazard cues in English, Spanish and Vietnamese, plus symptoms. Matching any of them pulls that hazard's cards in.
const CUES: Record<Exclude<Hazard, 'responder'>, RegExp> = {
  carbon_monoxide: /(carbon monoxide|monoxido|\bco\b|generator|generador|may phat|grill|parrilla|charcoal|carbon|car running|carro prendido|dizzy|mareo|headache|dolor de cabeza|nausea|vomit|confus|sleepy|somnolien|space heater|calentador|stove for heat|estufa|horno)/,
  hypothermia: /(hypotherm|hipoterm|cold|frio|freez|helad|shiver|tembl|temblor|numb|frostbite|congelac|no heat|sin calefaccion|lanh|blue lips|labios morados|slurred|very sleepy)/,
  water_main: /(pipe|tuberia|cano|burst|revent|reviento|frozen pipe|water main|llave de paso|shutoff|shut off|valve|valvula|leak|fuga|ceiling dripping|ong nuoc)/,
  flood: /(flood|inunda|water (is )?(coming|rising|entering)|agua (entrando|subiendo)|rising water|swept|current|corriente|nuoc|car in water|carro en el agua|evacua|higher ground)/,
  powered_device: /(oxygen|oxigeno|concentrator|ventilator|dialysis|dialisis|insulin|insulina|cpap|wheelchair electric|power(ed)? (medical )?device|equipo medico|may tho|nebulizer)/,
};

export interface ProfileHint {
  age?: number;
  poweredDevice?: boolean;
  medicalNeeds?: string;
  mobility?: string;
  livesAlone?: boolean;
}

/** Hazards suggested by the message and the person's profile. */
export function detectHazards(text: string, profile?: ProfileHint): Hazard[] {
  const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const found = new Set<Hazard>();
  for (const [h, re] of Object.entries(CUES) as [Hazard, RegExp][]) if (re.test(t)) found.add(h);
  if (profile?.poweredDevice || /oxygen|dialysis|insulin/i.test(profile?.medicalNeeds ?? '')) found.add('powered_device');
  if ((profile?.age ?? 0) >= 65 && /power|luz|electric|cold|frio/.test(t)) found.add('hypothermia');
  return [...found];
}

const SEVERITY_BOOST: Record<Severity, number> = { life_threat: 1.6, urgent: 1.2, advice: 1.0 };
const SEVERITY_RANK: Record<Severity, number> = { life_threat: 0, urgent: 1, advice: 2 };

export interface SearchOptions {
  k?: number;
  /** Hazards to pull in regardless of wording (from detectHazards or the caller). */
  hazards?: Hazard[];
  profile?: ProfileHint;
  /** Restrict to these hazards only. */
  only?: Hazard[];
  /** Dense scores keyed by card id, from an embedding retriever (0..1). Blended with BM25. */
  dense?: Map<string, number>;
}

/**
 * Top cards for a query. Ranking: relevance (BM25, optionally blended with dense) × severity boost,
 * with a floor for cards of detected hazards. Ties break toward life-threat cards.
 */
export function searchProtocols(query: string, opts: SearchOptions = {}): RetrievedCard[] {
  const k = opts.k ?? 4;
  const hazards = new Set([...(opts.hazards ?? []), ...detectHazards(query, opts.profile)]);
  const raw = index.scores(query);
  const max = Math.max(1e-9, ...raw);
  const scored = PROTOCOLS.map((c, i) => {
    let rel = raw[i] / max;
    const dense = opts.dense?.get(c.id);
    if (dense !== undefined) rel = 0.5 * rel + 0.5 * dense;
    if (hazards.has(c.hazard)) rel = Math.max(rel, 0.45) + 0.25;
    return { ...c, score: rel * SEVERITY_BOOST[c.severity] } as RetrievedCard;
  })
    .filter((c) => c.score > 0.05 && (!opts.only || opts.only.includes(c.hazard)))
    .sort((a, b) => b.score - a.score || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  // Emergencies first: among the clearly relevant cards (at least half the top score), life threats lead,
  // then urgent, then advice. Weakly related cards stay behind them in relevance order.
  const cut = (scored[0]?.score ?? 0) * 0.85;
  const strong = scored.filter((c) => c.score >= cut).sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.score - a.score);
  const weak = scored.filter((c) => c.score < cut);
  return [...strong, ...weak].slice(0, k);
}

export const cardById = (id: string) => PROTOCOLS.find((c) => c.id === id);

/** Compact form for a model prompt: id, severity, guidance, source. */
export const forPrompt = (cards: RetrievedCard[]) =>
  cards.map((c) => ({ id: c.id, severity: c.severity, guidance: c.text, source: `${c.source.org}: ${c.source.title}`, url: c.source.url }));
