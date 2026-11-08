/** Normalized feed item. One item can touch many H3 res-9 cells. */
export interface FeedEvent {
  source: string;
  kind: string;
  /** ISO 8601 */
  time: string;
  h3_cells: string[];
  payload: Record<string, unknown>;
}

export interface Feed {
  /** Same as FeedEvent.source */
  name: string;
  intervalMs: number;
  fetch(): Promise<FeedEvent[]>;
}
