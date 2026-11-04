import type { Break, Place, StopWarning, Trip, TripDay, Visit } from '@riflo/core';

/** DB rows are snake_case; the API speaks the camelCase types from @riflo/core. */

export const PLACE_COLUMNS = `p.id, p.city_id, p.name_ar, p.summary_ar, p.category, p.lat, p.lng, p.visit_minutes, p.cost_per_person,
  p.opening_hours, p.open_minute, p.close_minute, p.closed_weekdays, p.source, p.verified_at, p.best_time, p.etiquette, p.status, p.updated_at,
  (SELECT count(*)::int FROM reports r WHERE r.place_id = p.id AND r.status IN ('new', 'in_review', 'reopened')) AS open_reports`;

export interface PlaceRow {
  id: string; city_id: string; name_ar: string; summary_ar: string; category: Place['category']; lat: number; lng: number; visit_minutes: number;
  cost_per_person: string | number | null; opening_hours: string | null; open_minute: number | null; close_minute: number | null; closed_weekdays: number[] | null; source: string | null; verified_at: Date | string | null; best_time: Place['bestTime']; etiquette: string | null; status: Place['status'];
  updated_at: Date | string; open_reports: number;
}

const isoDate = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export function toPlace(r: PlaceRow): Place {
  return {
    id: r.id,
    cityId: r.city_id,
    name: r.name_ar,
    summary: r.summary_ar,
    category: r.category,
    location: { lat: Number(r.lat), lng: Number(r.lng) },
    visitMinutes: r.visit_minutes,
    costPerPerson: r.cost_per_person === null ? null : Number(r.cost_per_person),
    openingHours: r.opening_hours,
    hours: r.open_minute === null || r.close_minute === null ? null : { open: r.open_minute, close: r.close_minute, closedOn: (r.closed_weekdays ?? []).map(Number) },
    source: r.source,
    verifiedAt: r.verified_at === null ? null : isoDate(r.verified_at),
    bestTime: r.best_time,
    etiquette: r.etiquette,
    status: r.status,
    updatedAt: isoDate(r.updated_at),
    openReports: r.open_reports ?? 0
  };
}

export interface TripRow {
  id: string; city_id: string; title: string; start_date: Date | string; end_date: Date | string; travellers: number; trip_type: Trip['preferences']['tripType'];
  budget_total: string | number; interests: Trip['preferences']['interests']; around_prayer: boolean; relaxed_pace: boolean; created_at: Date | string;
  first_day_start: number | null; last_day_end: number | null;
}
export interface DayRow { day_index: number; date: Date | string; breaks: Break[] }
export interface StopRow { id: string; day_index: number; position: number; place_id: string; start_minute: number; travel_minutes: number | null; distance_km: string | number | null; warning: StopWarning | null }

export function toTrip(t: TripRow, days: DayRow[], stops: StopRow[]): Trip {
  const tripDays: TripDay[] = days
    .sort((a, b) => a.day_index - b.day_index)
    .map((d) => ({
      date: isoDate(d.date),
      breaks: d.breaks,
      stops: stops
        .filter((s) => s.day_index === d.day_index)
        .sort((a, b) => a.position - b.position)
        .map((s) => ({ id: s.id, placeId: s.place_id, start: s.start_minute, travelFromPrevious: s.travel_minutes, distanceFromPreviousKm: s.distance_km === null ? null : Number(s.distance_km), ...(s.warning ? { warning: s.warning } : {}) }))
    }));
  return {
    id: t.id,
    title: t.title,
    saved: true,
    createdAt: new Date(t.created_at).toISOString(),
    days: tripDays,
    preferences: {
      cityId: t.city_id,
      startDate: isoDate(t.start_date),
      endDate: isoDate(t.end_date),
      travellers: t.travellers,
      tripType: t.trip_type,
      budgetTotal: Number(t.budget_total),
      interests: t.interests,
      aroundPrayerTimes: t.around_prayer,
      relaxedPace: t.relaxed_pace,
      firstDayStart: t.first_day_start,
      lastDayEnd: t.last_day_end
    }
  };
}

export interface VisitRow { id: string; place_id: string; trip_id: string | null; visited_on: Date | string; rating: number | null; note: string; source: Visit['source'] }
export const VISIT_COLUMNS = 'id, place_id, trip_id, visited_on, rating, note, source';
export const toVisit = (v: VisitRow): Visit => ({ id: v.id, placeId: v.place_id, tripId: v.trip_id, date: isoDate(v.visited_on), rating: v.rating, note: v.note, source: v.source });
