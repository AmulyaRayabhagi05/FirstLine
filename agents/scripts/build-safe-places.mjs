// Builds the list of places FirstLine directs Priority 1 cases to, from OpenStreetMap (Overpass):
//   er      general hospitals tagged emergency=yes (specialty, children's and VA hospitals left out)
//   warming City of Dallas recreation centers and Dallas Public Library branches (the city opens them as
//           warming stations in freezes; whether one is open tonight must be confirmed), plus the
//           Kay Bailey Hutchison Convention Center (a mass shelter in Harvey, a warming center in Uri).
// Writes agents/src/places/safe-places.json and web/src/data/safe-places.json (same content).
// Run from agents/:  node scripts/build-safe-places.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BBOX = '32.55,-97.05,33.03,-96.46';
const UA = 'FirstLine-HackUTD (github.com/AmulyaRayabhagi05/FirstLine)';

// Overpass is often busy (429/502/504): retry with backoff.
async function overpass(body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ data: `[out:json][timeout:120];(${body});out center tags;` }),
    });
    if (res.ok) return (await res.json()).elements;
    if (attempt >= 5) throw new Error(`Overpass ${res.status}`);
    await new Promise((r) => setTimeout(r, attempt * 10_000));
  }
}

const pos = (e) => ({ lat: +(e.lat ?? e.center.lat).toFixed(5), lng: +(e.lon ?? e.center.lon).toFixed(5) });
const addr = (t) => [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:city']].filter(Boolean).join(', ') || null;

const hospitals = await overpass(`nwr["amenity"="hospital"]["emergency"="yes"](${BBOX});`);
const er = hospitals
  // General emergency rooms only: no specialty (surgical, orthopedic, heart, rehab, continuing care),
  // children's or VA (veterans only) hospitals.
  .filter((e) => e.tags.name && !/surgical|surgery|orthopedic|continuing care|rehab|heart|children|\bVA\b|veteran/i.test(e.tags.name))
  .map((e) => ({ id: `osm:${e.type}/${e.id}`, kind: 'er', name: e.tags.name.replace(/​/g, ''), address: addr(e.tags), ...pos(e), note: 'Emergency room' }));

const centers = await overpass(`nwr["amenity"="community_centre"](${BBOX});nwr["leisure"="sports_centre"]["operator"~"Dallas",i](${BBOX});nwr["amenity"="library"](${BBOX});`);
const isDallasRec = (t) => /recreation/i.test(t.name ?? '') && (/dallas/i.test(t.operator ?? '') || /dallas/i.test(t['addr:city'] ?? '') || /^(Pleasant Oaks|Fretz|Reverchon|Grauwyler|Park in the Woods|Nash-Davis|Juanita J\. Craft)/i.test(t.name ?? ''));
const isDallasLibrary = (t) =>
  t.amenity === 'library' && (/dallas public library/i.test(`${t.operator ?? ''} ${t.name ?? ''}`) || /branch library$/i.test(t.name ?? '')) && !/bookmarks|garland|^east branch/i.test(t.name ?? '');
const warming = centers
  .filter((e) => e.tags.name && (isDallasRec(e.tags) || isDallasLibrary(e.tags) || /salvation army/i.test(e.tags.name)))
  .map((e) => ({
    id: `osm:${e.type}/${e.id}`,
    kind: 'warming',
    name: e.tags.name,
    address: addr(e.tags),
    ...pos(e),
    note: e.tags.amenity === 'library' ? 'Library: a city warming station in freezes, confirm it is open' : /salvation/i.test(e.tags.name) ? 'Salvation Army center: confirm it is open' : 'Recreation center: a city warming station in freezes, confirm it is open',
  }));
warming.push({
  id: 'manual:kbhcc',
  kind: 'warming',
  name: 'Kay Bailey Hutchison Convention Center',
  address: '650 S Griffin St, Dallas',
  lat: 32.77436,
  lng: -96.80006,
  note: 'Citywide mass shelter (Harvey 2017) and warming center (Uri 2021): confirm it is open',
});

const places = [...er, ...warming].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
const json = JSON.stringify({ source: 'OpenStreetMap via Overpass (ODbL)', built: new Date().toISOString().slice(0, 10), places }, null, 1) + '\n';
for (const out of [resolve(here, '../src/places/safe-places.json'), resolve(here, '../../web/src/data/safe-places.json')]) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
}
console.log(`${er.length} ERs, ${warming.length} warming/shelter sites`);
