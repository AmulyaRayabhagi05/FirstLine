import type { Feed } from './types.js';
import { nwsAlertsFeed } from './nwsAlerts.js';
import { nwsForecastFeed } from './nwsForecast.js';
import { femaSheltersFeed } from './femaShelters.js';
import { hhsEmpowerFeed } from './hhsEmpower.js';
import { dallasPoliceFeed } from './dallasPolice.js';
import { osmFacilitiesFeed } from './osmFacilities.js';
import { censusAcsFeed } from './censusAcs.js';
import { openMeteoFeed } from './openMeteo.js';

export type { Feed, FeedEvent } from './types.js';
export * from './nwsAlerts.js';
export * from './nwsForecast.js';
export * from './femaShelters.js';
export * from './hhsEmpower.js';
export * from './dallasPolice.js';
export * from './osmFacilities.js';
export * from './censusAcs.js';
export * from './openMeteo.js';
export { pointCell, geometryCells, H3_RES } from './util.js';

export const allFeeds: Feed[] = [
  nwsAlertsFeed,
  nwsForecastFeed,
  femaSheltersFeed,
  hhsEmpowerFeed,
  dallasPoliceFeed,
  osmFacilitiesFeed,
  censusAcsFeed,
  openMeteoFeed,
];
