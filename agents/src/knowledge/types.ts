// A protocol card: one piece of official guidance, written in plain language, with its source.
// Cards are what the retriever returns and what agents cite (by id) in their decisions.

export type Hazard = 'hypothermia' | 'carbon_monoxide' | 'water_main' | 'flood' | 'powered_device' | 'responder';

/** life_threat ranks first: anything that can kill in minutes to hours. */
export type Severity = 'life_threat' | 'urgent' | 'advice';

export interface ProtocolCard {
  id: string; // short and stable, e.g. "co-generator-distance"; agents cite it as [co-generator-distance]
  hazard: Hazard;
  severity: Severity;
  title: string;
  /** The guidance, paraphrased. One to three short sentences. */
  text: string;
  /** Extra search terms (synonyms, Spanish, symptoms) that should find this card. */
  keywords: string[];
  source: { org: string; title: string; url: string };
  /** Optional line a phone call can read aloud (English and Spanish). */
  say?: { en: string; es: string };
}

export interface RetrievedCard extends ProtocolCard {
  score: number;
}
