import { isValidIsoDate, MAX_DAYS } from '@riflo/core';
import { z } from 'zod';

/** A real calendar date (audit 5.3): 2026-02-30, 2026-99-99 and 2025-02-29 are rejected with 400. */
export const isoDate = z.string().refine(isValidIsoDate, { message: 'invalid calendar date (yyyy-mm-dd)' });
export const category = z.enum(['religious', 'history', 'nature', 'market', 'food', 'museum']);
export const placeId = z.string().regex(/^[a-z0-9-]{2,80}$/, 'invalid place id');
/** Client-generated planning-session id (random, 16–64 url-safe characters). */
export const sessionId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
export const anonymousId = z.string().regex(/^anon_[A-Za-z0-9]{8,64}$/);

const dayDiff = (a: string, b: string) => (Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 864e5;

export const Preferences = z
  .object({
    cityId: z.string().min(1).max(40),
    startDate: isoDate,
    endDate: isoDate,
    travellers: z.number().int().min(1).max(20),
    tripType: z.enum(['family', 'friends', 'solo', 'couple']),
    budgetTotal: z.number().finite().min(0).max(10_000_000),
    interests: z.array(category).max(6),
    aroundPrayerTimes: z.boolean(),
    relaxedPace: z.boolean(),
    /** Late arrival / early departure, minutes from midnight. */
    firstDayStart: z.number().int().min(0).max(1440).nullable().optional(),
    lastDayEnd: z.number().int().min(0).max(1440).nullable().optional()
  })
  .refine((p) => p.startDate !== p.endDate || p.firstDayStart == null || p.lastDayEnd == null || p.firstDayStart < p.lastDayEnd, { message: 'a one-day trip must start before it ends', path: ['lastDayEnd'] })
  .refine((p) => p.endDate >= p.startDate, { message: 'endDate before startDate', path: ['endDate'] })
  .refine((p) => dayDiff(p.startDate, p.endDate) < MAX_DAYS, { message: `max ${MAX_DAYS} days`, path: ['endDate'] });

/** Clients send the order of places per day; the server computes times, travel and breaks. */
export const TripInput = z.object({
  title: z.string().trim().min(1).max(120),
  preferences: Preferences,
  days: z.array(z.object({ placeIds: z.array(placeId).max(12) })).min(1).max(MAX_DAYS),
  reusedFrom: z.string().uuid().optional(),
  sessionId: sessionId.optional(),
  /**
   * Hints from the client, used only when a trip is created: places the plan left out (kept if published in the
   * city) and places the traveller explicitly excluded. Ignored on edits — the server's saved selection is the source.
   */
  unscheduled: z.array(placeId).max(50).optional(),
  excluded: z.array(placeId).max(50).optional()
});

const minute = z.number().int().min(0).max(1440);
export const PlaceInput = z.object({
  id: placeId.optional(),
  cityId: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(500),
  category,
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  visitMinutes: z.number().int().min(5).max(600),
  costPerPerson: z.number().finite().min(0).max(100_000).nullable(),
  openingHours: z.string().trim().max(200).nullable(),
  hours: z
    .object({ open: minute.max(1439), close: minute.min(1), closedOn: z.array(z.number().int().min(0).max(6)).max(7).default([]) })
    .refine((h) => h.open < h.close, 'open must be before close')
    .transform((h) => ({ ...h, closedOn: [...new Set(h.closedOn)].sort() }))
    .nullable()
    .default(null),
  source: z.string().trim().max(300).nullable().default(null),
  verifiedAt: isoDate.nullable().default(null),
  bestTime: z.enum(['morning', 'afternoon', 'evening', 'any']),
  etiquette: z.string().trim().max(500).nullable()
});

export const PlaceStatus = z.enum(['draft', 'review', 'published', 'hidden']);

/** Analytics events: an allowlist of names and of props per name, with types and sizes (audit 3.5). */
export const ClientEvent = z.discriminatedUnion('name', [
  z.object({ name: z.literal('plan_started'), props: z.object({ cityId: z.string().max(40).optional() }).strict().default({}), anonymousId: anonymousId.optional(), sessionId: sessionId.optional() }).strict(),
  z.object({ name: z.literal('plan_step_completed'), props: z.object({ step: z.number().int().min(1).max(3) }).strict(), anonymousId: anonymousId.optional(), sessionId: sessionId.optional() }).strict()
]);
