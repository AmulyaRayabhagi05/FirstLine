// Pushes the generated world and the storm through a SimStore (the worker's PorchlightStore,
// backed by SpacetimeDB at integration). Sim person ids are remapped to whatever ids the store
// returns, so loading into a non-empty database is safe.
import { helperDecision, playStorm, type PlayOptions, type Storm, type StormEvent } from "../storm.js";
import type { Person, World } from "../types.js";
import type { HelperBotStore, Id, SimStore } from "./types.js";

export interface IdMap {
  toStore: Map<number, Id>;
  fromStore: Map<Id, number>;
}

export interface LoadOptions {
  /** Max concurrent reducer calls while registering people. */
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

async function pool<T>(items: T[], concurrency: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

/** register_person for everyone, then set_safety_net for every owner. */
export async function loadWorld(store: SimStore, world: World, opts: LoadOptions = {}): Promise<IdMap> {
  const conc = opts.concurrency ?? 16;
  const toStore = new Map<number, Id>();
  const fromStore = new Map<Id, number>();
  const hh = new Map(world.households.map((h) => [h.id, h]));
  let done = 0;
  const total = world.people.length;
  // Register in id order (demo characters first) so a fresh database gives them ids 1..5.
  for (let start = 0; start < world.people.length; start += conc) {
    const batch = world.people.slice(start, start + conc);
    const ids = await Promise.all(
      batch.map((p) =>
        store.registerPerson({
          name: p.name,
          age: p.age,
          livesAlone: p.livesAlone,
          mobility: p.mobility,
          medicalNeeds: p.medicalNeeds,
          poweredDevice: p.poweredDevice,
          hasSmartphone: p.hasSmartphone,
          language: p.language,
          phone: p.phone,
          address: hh.get(p.householdId)!.address,
          lat: p.lat,
          lng: p.lng,
        }),
      ),
    );
    batch.forEach((p, k) => {
      toStore.set(p.id, ids[k].personId);
      fromStore.set(ids[k].personId, p.id);
    });
    done += batch.length;
    opts.onProgress?.(done, total);
  }
  const byOwner = new Map<number, typeof world.nets>();
  for (const m of world.nets) {
    const l = byOwner.get(m.ownerId);
    if (l) l.push(m);
    else byOwner.set(m.ownerId, [m]);
  }
  await pool([...byOwner.entries()], conc, async ([owner, members]) => {
    await store.setSafetyNet(
      toStore.get(owner)!,
      members.map((m) => ({ memberId: toStore.get(m.memberId)!, ring: m.ring, skills: m.skills })),
    );
  });
  return { toStore, fromStore };
}

/** Sends one storm event to the store. Readings are Tiger-only and are skipped here. */
export async function applyEvent(store: SimStore, ids: IdMap, e: StormEvent): Promise<void> {
  const pid = (id: number) => ids.toStore.get(id) ?? id;
  switch (e.kind) {
    case "signal":
      await store.reportSignal(pid(e.personId), e.signal, e.value);
      return;
    case "check_in":
      await store.checkIn({ clientId: e.clientId, personId: pid(e.personId), kind: e.checkKind, result: e.result, note: e.note });
      return;
    case "sos":
      await store.pressSos({ clientId: e.clientId, personId: pid(e.personId), message: e.message, lat: e.lat, lng: e.lng, channel: e.channel });
      return;
    case "reading":
      return;
  }
}

export async function playIntoStore(store: SimStore, ids: IdMap, storm: Storm, opts: PlayOptions & { onEvent?: (e: StormEvent) => void } = {}): Promise<number> {
  return playStorm(
    storm,
    async (e) => {
      await applyEvent(store, ids, e);
      opts.onEvent?.(e);
    },
    opts,
  );
}

/**
 * Plays the neighbors: polls offered assignments and answers them as the sim's helper profiles
 * say (accept / decline / leave it to time out). Marcus never answers, Linh accepts.
 * `speed` scales answer latency the same way the storm playback does.
 */
export function startHelperBot(
  store: HelperBotStore,
  world: World,
  storm: Storm,
  ids: IdMap,
  opts: { speed?: number; pollMs?: number; stormMinuteNow?: () => number; log?: (s: string) => void } = {},
): () => void {
  const speed = opts.speed ?? 60;
  const seen = new Set<Id>();
  const timers: NodeJS.Timeout[] = [];
  const people = new Map<number, Person>(world.people.map((p) => [p.id, p]));
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      for (const sos of await store.listOpenSos()) {
        for (const a of await store.listAssignments(sos.id)) {
          if (a.state !== "offered" || seen.has(a.id)) continue;
          seen.add(a.id);
          const helper = people.get(ids.fromStore.get(a.helperId) ?? a.helperId);
          if (!helper) continue;
          const now = opts.stormMinuteNow?.() ?? 0;
          const d = helperDecision(storm, helper, `sos:${sos.id}`, now);
          opts.log?.(`helper ${helper.name} -> ${d.action}${d.action === "no_answer" ? "" : ` after ${d.afterMin} min`}`);
          if (d.action === "no_answer") continue; // the module's assignment_timeout handles it
          const ms = (d.afterMin * 60_000) / speed;
          timers.push(
            setTimeout(() => {
              const call = d.action === "accept" ? store.acceptAssignment(a.id) : store.declineAssignment(a.id);
              call.catch((err) => opts.log?.(`helper answer failed: ${err}`));
            }, ms),
          );
        }
      }
    } catch (err) {
      opts.log?.(`helper bot poll failed: ${err}`);
    }
    if (!stopped) timers.push(setTimeout(tick, opts.pollMs ?? 3000));
  };
  void tick();
  return () => {
    stopped = true;
    timers.forEach(clearTimeout);
  };
}
