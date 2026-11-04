import { distanceKm } from './geo';
import type { City, Place } from './types';

export type PublishProblem = 'summary' | 'hours' | 'cost' | 'location' | 'duration';

/** Places farther than this from the city centre are assumed to be mis-entered. */
const MAX_KM_FROM_CITY = 80;
export const STALE_DAYS = 180;

/**
 * What stops a place from being published (audit 5.5). Shared by the API, which enforces it,
 * and the admin, which explains it.
 */
export function publishProblems(p: Pick<Place, 'summary' | 'hours' | 'costPerPerson' | 'location' | 'visitMinutes'>, city?: Pick<City, 'location'>): PublishProblem[] {
  const out: PublishProblem[] = [];
  if (!p.summary.trim()) out.push('summary');
  if (!p.hours) out.push('hours');
  if (p.costPerPerson === null) out.push('cost');
  if (!(p.visitMinutes > 0)) out.push('duration');
  if (city && distanceKm(city.location, p.location) > MAX_KM_FROM_CITY) out.push('location');
  return out;
}

export function isStalePlace(p: Pick<Place, 'updatedAt'>, now = new Date()): boolean {
  return (now.getTime() - new Date(p.updatedAt).getTime()) / 864e5 > STALE_DAYS;
}

/** "Today" as a calendar date in a city's time zone (visits can't be in the future there). */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
