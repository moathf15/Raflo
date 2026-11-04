import { CalculationMethod, Coordinates, Madhab, PrayerTimes } from 'adhan';
import type { LatLng, PrayerName } from './types';

export interface PrayerTime {
  prayer: PrayerName;
  /** Minutes from midnight in the city's time zone. */
  at: number;
}

function minutesIn(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/**
 * Daytime prayers for a city and calendar date, Umm Al-Qura method (the official Saudi calendar
 * method; Isha 90 minutes after Maghrib, 120 in Ramadan per the method's definition), Shafi'i Asr.
 * Computed offline, so it works in the API and in the browser alike.
 */
export function prayerTimes(location: LatLng, timeZone: string, isoDate: string): PrayerTime[] {
  const [y, m, d] = isoDate.split('-').map(Number);
  const params = CalculationMethod.UmmAlQura();
  params.madhab = Madhab.Shafi;
  const t = new PrayerTimes(new Coordinates(location.lat, location.lng), new Date(y, m - 1, d, 12), params);
  return [
    { prayer: 'dhuhr', at: minutesIn(t.dhuhr, timeZone) },
    { prayer: 'asr', at: minutesIn(t.asr, timeZone) },
    { prayer: 'maghrib', at: minutesIn(t.maghrib, timeZone) },
    { prayer: 'isha', at: minutesIn(t.isha, timeZone) }
  ];
}
