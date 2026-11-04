import { locale } from '../i18n';

/** 570 → { time: '9:30', period: 'صباحًا' } */
export function clock(minutes: number) {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const period = h24 < 12 ? 'صباحًا' : h24 < 15 ? 'ظهرًا' : h24 < 18 ? 'عصرًا' : 'مساءً';
  return { time: `${h12}:${String(m).padStart(2, '0')}`, period };
}

// Dates are calendar days (yyyy-mm-dd). All maths runs in UTC so no timezone can shift a day.
const utc = (iso: string) => new Date(iso + 'T00:00:00Z');

export const shortDate = (iso: string) => utc(iso).toLocaleDateString(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
export const money = (n: number) => n.toLocaleString('en-US');

/** Today in the user's own timezone. */
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function addDays(iso: string, n: number) {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const daysUntil = (iso: string) => Math.round((utc(iso).getTime() - utc(todayIso()).getTime()) / 864e5);
