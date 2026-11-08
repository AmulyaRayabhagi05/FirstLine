// Static inputs: Dallas neighborhoods, name pools, street names.
import type { Language } from "./types.js";

export interface Neighborhood {
  name: string;
  /** Residential bounding box. */
  latMin: number;
  latMax: number;
  lngMin: number;
  lngMax: number;
  /** Share of the city sample living here. */
  share: number;
  language: Record<Language, number>;
  /** Extra weight on 65+ household heads (1 = city average). */
  seniorBoost: number;
  /** Senior apartment complexes: households near these skew 65+. */
  seniorClusters: { lat: number; lng: number }[];
  streets: string[];
}

export const NEIGHBORHOODS: Neighborhood[] = [
  {
    name: "North Oak Cliff",
    latMin: 32.728, latMax: 32.758, lngMin: -96.858, lngMax: -96.812,
    share: 0.28,
    language: { en: 0.42, es: 0.55, vi: 0.03 },
    seniorBoost: 1.2,
    seniorClusters: [{ lat: 32.744, lng: -96.829 }],
    streets: ["W Davis St", "N Tyler St", "N Bishop Ave", "W 7th St", "Kessler Pkwy", "N Edgefield Ave", "W Jefferson Blvd", "N Clinton Ave"],
  },
  {
    name: "Pleasant Grove",
    latMin: 32.692, latMax: 32.722, lngMin: -96.718, lngMax: -96.672,
    share: 0.24,
    language: { en: 0.32, es: 0.65, vi: 0.03 },
    seniorBoost: 1.3,
    seniorClusters: [{ lat: 32.706, lng: -96.695 }],
    streets: ["Buckner Blvd", "Lake June Rd", "Jim Miller Rd", "Elam Rd", "Pleasant Dr", "St Augustine Dr", "Bruton Rd"],
  },
  {
    name: "Lakewood",
    latMin: 32.806, latMax: 32.830, lngMin: -96.764, lngMax: -96.736,
    share: 0.18,
    language: { en: 0.88, es: 0.1, vi: 0.02 },
    seniorBoost: 1.8,
    seniorClusters: [{ lat: 32.818, lng: -96.748 }, { lat: 32.811, lng: -96.757 }],
    streets: ["Gaston Ave", "Abrams Rd", "Lakewood Blvd", "Tokalon Dr", "Westlake Ave", "Swiss Ave", "Coronado Ave"],
  },
  {
    name: "Vickery Meadow",
    latMin: 32.860, latMax: 32.877, lngMin: -96.774, lngMax: -96.754,
    share: 0.15,
    language: { en: 0.4, es: 0.4, vi: 0.2 },
    seniorBoost: 0.8,
    seniorClusters: [],
    streets: ["Ridgecrest Rd", "Holly Hill Dr", "Fair Oaks Ave", "Park Ln", "Melody Ln", "Greenville Ave"],
  },
  {
    name: "West Dallas",
    latMin: 32.771, latMax: 32.790, lngMin: -96.889, lngMax: -96.856,
    share: 0.15,
    language: { en: 0.38, es: 0.6, vi: 0.02 },
    seniorBoost: 1.1,
    seniorClusters: [{ lat: 32.780, lng: -96.873 }],
    streets: ["Singleton Blvd", "Bataan St", "Pueblo St", "N Hampton Rd", "Chalk Hill Rd", "Toronto St"],
  },
];

export const FIRST_NAMES: Record<Language, { f: string[]; m: string[] }> = {
  en: {
    f: ["Mary", "Linda", "Patricia", "Barbara", "Susan", "Jessica", "Ashley", "Emily", "Sarah", "Dorothy", "Betty", "Karen", "Brittany", "Megan", "Gloria", "Ruth", "Tasha", "Keisha"],
    m: ["James", "Robert", "John", "Michael", "David", "William", "Richard", "Charles", "Joseph", "Thomas", "Daniel", "Tyrone", "Darnell", "Kevin", "Brian", "Earl", "Walter", "Harold"],
  },
  es: {
    f: ["Maria", "Guadalupe", "Rosa", "Juana", "Ana", "Carmen", "Leticia", "Veronica", "Yesenia", "Alejandra", "Lucia", "Elena", "Sofia", "Marisol", "Esperanza", "Dolores"],
    m: ["Jose", "Juan", "Luis", "Carlos", "Jesus", "Miguel", "Francisco", "Antonio", "Alejandro", "Javier", "Ramon", "Hector", "Eduardo", "Raul", "Mateo", "Diego"],
  },
  vi: {
    f: ["Linh", "Huong", "Mai", "Lan", "Thao", "Ngoc", "Trang", "Hoa", "Phuong", "Anh"],
    m: ["Minh", "Tuan", "Hung", "Dung", "Quang", "Khoa", "Long", "Bao", "Thanh", "Duc"],
  },
};

export const LAST_NAMES: Record<Language, string[]> = {
  en: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Davis", "Miller", "Wilson", "Moore", "Taylor", "Anderson", "Jackson", "White", "Harris", "Thompson", "Robinson", "Walker", "Young", "Allen", "King"],
  es: ["Garcia", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Rodriguez", "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera", "Gomez", "Diaz", "Reyes", "Morales", "Ortiz", "Cruz"],
  vi: ["Nguyen", "Tran", "Le", "Pham", "Hoang", "Vu", "Dang", "Bui", "Do", "Ho"],
};

/** Dallas-area codes used with the reserved fictional 555-01xx block. */
export const AREA_CODES = ["214", "469", "972"];
