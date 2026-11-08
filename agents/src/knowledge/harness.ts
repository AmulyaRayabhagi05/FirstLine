// The knowledge harness Nemotron works inside:
// 1. RESPONDER_RULES: how trained responders decide who goes first (goes into the agent's instructions).
// 2. lookup_protocol: a tool the agent calls to retrieve cited guidance for what it is seeing.
// 3. spokenGuidance: short cited lines the phone-call script reads aloud.

import { z } from 'zod';
import { defineTool } from '../agents/loop.js';
import { DenseIndex, embedConfigFromEnv } from './embed.js';
import { detectHazards, forPrompt, searchProtocols, type ProfileHint } from './retrieve.js';
import { PROTOCOLS } from './protocols.js';
import type { Hazard } from './types.js';

export { RESPONDER_RULES } from './protocols.js';

const embedCfg = embedConfigFromEnv();
const dense = embedCfg ? new DenseIndex(embedCfg) : null;

export async function retrieve(query: string, opts: { k?: number; hazards?: Hazard[]; profile?: ProfileHint } = {}) {
  const denseScores = dense ? await dense.scores(query) : null;
  return searchProtocols(query, { ...opts, dense: denseScores ?? undefined });
}

const lookupInput = z.object({
  query: z.string().min(2).describe('What you need guidance on, e.g. "generator running inside, headache" or "water rising, cannot walk"'),
  hazard: z
    .enum(['hypothermia', 'carbon_monoxide', 'water_main', 'flood', 'powered_device', 'responder'])
    .optional()
    .describe('Optional: the hazard, if you already know it'),
});

/** Agent tool: cited guidance, emergencies first. The agent cites card ids in its reason, e.g. [co-symptoms-911]. */
export function makeLookupProtocolTool(profile?: () => Promise<ProfileHint | undefined>) {
  return defineTool({
    name: 'lookup_protocol',
    description:
      'Official safety guidance (CDC, FEMA/Ready.gov, Red Cross, NWS) for what the message describes: hypothermia, carbon monoxide, floods, burst pipes and the water main, powered medical devices, and responder triage rules. Returns cards with an id, severity and source. Cite card ids in your reason.',
    input: lookupInput,
    run: async ({ query, hazard }) => {
      const p = profile ? await profile() : undefined;
      const cards = await retrieve(query, { k: 4, hazards: hazard ? [hazard] : undefined, profile: p });
      return { cards: forPrompt(cards) };
    },
  });
}

/**
 * Lines for an automated check-in call: the most important cited guidance for this person and situation,
 * life threats first. Defaults to the winter-storm basics (carbon monoxide, staying warm).
 */
export function spokenGuidance(opts: { lang: 'en' | 'es'; context?: string; profile?: ProfileHint; max?: number }): string[] {
  const hazards = new Set<Hazard>(detectHazards(opts.context ?? '', opts.profile));
  // A routine check-in call (no situation described yet) leads with prevention: where to put the
  // generator, and when cold becomes an emergency.
  const routine = hazards.size === 0;
  if (routine) {
    hazards.add('carbon_monoxide');
    hazards.add('hypothermia');
  }
  if (opts.profile?.poweredDevice) hazards.add('powered_device');
  const query = opts.context || (routine ? 'keep generator outside 20 feet windows garage; confused sleepy cold hypothermia call 911' : [...hazards].join(' '));
  const cards = searchProtocols(query, { k: 12, hazards: [...hazards], profile: opts.profile })
    .filter((c) => c.say && hazards.has(c.hazard));
  // one line per hazard, most severe first
  const seen = new Set<Hazard>();
  const lines: string[] = [];
  for (const c of cards) {
    if (seen.has(c.hazard)) continue;
    seen.add(c.hazard);
    lines.push(c.say![opts.lang]);
    if (lines.length >= (opts.max ?? 2)) break;
  }
  return lines;
}

export const PROTOCOL_COUNT = PROTOCOLS.length;
