// Domain model shared by the user app, the admin dashboard and the API.

export type CategoryId = 'religious' | 'history' | 'nature' | 'market' | 'food' | 'museum';

export type TripType = 'family' | 'friends' | 'solo' | 'couple';

export type BudgetLevel = 'economy' | 'standard' | 'comfort';

/** Content lifecycle used by the admin board. Only `published` places reach users. */
export type PlaceStatus = 'draft' | 'review' | 'published' | 'hidden';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place {
  id: string;
  cityId: string;
  name: string;
  summary: string;
  category: CategoryId;
  location: LatLng;
  /** Typical visit length in minutes. */
  visitMinutes: number;
  /** Estimated cost per person in SAR. null = unknown, shown as a placeholder. */
  costPerPerson: number | null;
  /** Opening hours as shown to visitors (free text). null = not entered yet. */
  openingHours: string | null;
  /** Daily opening window in minutes from midnight (close ≤ 1440), used by the planner at arrival time. null = unknown. */
  hours: OpeningHours | null;
  /** Where the information came from (official site, phone call, visit…). */
  source: string | null;
  /** Date the information was last checked. */
  verifiedAt: string | null;
  bestTime: 'morning' | 'afternoon' | 'evening' | 'any';
  etiquette: string | null;
  status: PlaceStatus;
  /** ISO date of the last content review. */
  updatedAt: string;
  /** Number of open user reports about this place. */
  openReports: number;
}

export interface City {
  id: string;
  name: string;
  location: LatLng;
  /** IANA time zone used for prayer times and "today". */
  timezone: string;
}

/** Daily opening window in minutes from midnight (close 1440 = midnight), and weekdays it is closed (0 = Sunday … 6 = Saturday). */
export interface OpeningHours {
  open: number;
  close: number;
  closedOn?: number[];
}

export interface TripPreferences {
  cityId: string;
  startDate: string; // ISO yyyy-mm-dd
  endDate: string;
  travellers: number;
  tripType: TripType;
  budgetTotal: number;
  interests: CategoryId[];
  aroundPrayerTimes: boolean;
  relaxedPace: boolean;
  /** Earliest start on the first day, minutes from midnight (late arrival). null = the normal day start. */
  firstDayStart?: number | null;
  /** Latest end on the last day, minutes from midnight (early departure). null = the normal day end. */
  lastDayEnd?: number | null;
}

/** outside_hours: the visit does not fit the opening hours; closed_that_day: closed on that weekday; hours_unknown: no hours entered. */
export type StopWarning = 'outside_hours' | 'closed_that_day' | 'hours_unknown';

export interface Stop {
  id: string;
  placeId: string;
  /** Minutes from midnight. */
  start: number;
  /** Estimated travel time in minutes from the previous stop (null for the first stop of a day). */
  travelFromPrevious: number | null;
  /** Estimated road distance from the previous stop. */
  distanceFromPreviousKm: number | null;
  /** Set when the planned time is outside the place's opening hours, or the hours are unknown. */
  warning?: StopWarning;
}

export type PrayerName = 'dhuhr' | 'asr' | 'maghrib' | 'isha';

export interface Break {
  kind: 'prayer';
  prayer: PrayerName;
  /** Prayer time, minutes from midnight in the city's time zone. */
  at: number;
  /** End of the break. */
  until: number;
  /** The break follows stop `afterStop` (-1 = before the first stop). */
  afterStop: number;
  /** True when the prayer happens during a visit to a mosque, so no separate stop is needed. */
  atPlace: boolean;
  /**
   * Where the break sits, for display in time order:
   * before_travel — prayed before driving to stop afterStop+1; waiting — while waiting for that stop to open;
   * in_visit — the visit to stop afterStop pauses for the prayer (inside the mosque when atPlace);
   * end_of_day — after the last stop. Missing on trips saved before 4 Nov 2026.
   */
  phase?: 'before_travel' | 'waiting' | 'in_visit' | 'end_of_day';
}

export interface TripDay {
  date: string;
  stops: Stop[];
  breaks: Break[];
}

/**
 * closed_on_trip_days: closed (or outside its hours) on every day of the trip;
 * longer_than_day: the visit is longer than the time available on any day;
 * no_time_left: it would fit, but every day is already full;
 * not_added: it fits on `canFitOn` — the traveller removed it or has not added it;
 * unavailable: chosen for the trip but no longer published.
 */
export type UnscheduledReason = 'closed_on_trip_days' | 'longer_than_day' | 'no_time_left' | 'not_added' | 'unavailable';
export interface UnscheduledPlace {
  placeId: string;
  reason: UnscheduledReason;
  /** With `not_added`: a day of the trip where the place would fit as the days are now. */
  canFitOn?: string;
}

/** Why a day cannot be kept as edited (manual changes are checked like generated plans). */
export interface DayProblem {
  date: string;
  placeId?: string;
  problem: 'outside_hours' | 'closed_that_day' | 'past_day_end';
}

export interface Trip {
  id: string;
  title: string;
  preferences: TripPreferences;
  days: TripDay[];
  /** Chosen places that are not in any day, with the reason. Computed by the server from `selected` and the days. */
  unscheduled?: UnscheduledPlace[];
  /**
   * Every place chosen for this saved trip (server-owned): scheduled or not. Set by the server only — changed by
   * scheduling a place, choosing it, or removing it explicitly. Absent on unsaved plans.
   */
  selected?: string[];
  /** Unsaved plans only: places the traveller removed from the plan; sent once when the trip is first saved. */
  excluded?: string[];
  saved: boolean;
  createdAt: string;
}

export interface Visit {
  id: string;
  placeId: string;
  tripId: string | null;
  date: string;
  rating: number | null;
  note: string;
  /** Visits are logged by the user; nothing proves physical presence. Never use self-reported visits for rewards. */
  source: 'self_reported' | 'verified';
}

export interface Passport {
  displayName: string | null;
  visits: Visit[];
  wishList: string[];
  /** Last preferences used, so the next trip starts pre-filled. */
  lastPreferences: Omit<TripPreferences, 'startDate' | 'endDate'> | null;
}

export interface PassportStats {
  trips: number;
  /** Distinct places with at least one logged visit. */
  placesVisited: number;
  /** All logged visits, including repeat visits to the same place. */
  visits: number;
  travelDays: number;
}

/** Each metric says how it is computed; the admin shows these definitions next to the numbers (audit 5.7). */
export interface AdminOverview {
  staleCount: number;
  reportCount: number;
  draftCount: number;
  periodDays: number;
  /** Null until there is data to compute them from. */
  metrics: {
    /** All accounts with role "user". */
    registeredUsers: number | null;
    /** Users who generated a plan, saved a trip or logged a visit in the period. */
    activeUsers: number | null;
    /** Trips saved in the period. */
    tripsCreated: number | null;
    /** Planning sessions that reached a ready plan ÷ sessions that started, same session id, in the period. */
    completionRate: number | null;
    /** Of users whose first trip is 90+ days old, the share who saved another trip within 90 days of it. */
    returnRate: number | null;
  };
  /** Planning sessions reaching each step in the period (counted once per session). */
  funnel?: { step: 'plan_started' | 'plan_step_completed' | 'plan_ready' | 'trip_saved'; count: number }[];
  /** Places most often included in trips saved in the period. */
  topPlaces?: { placeId: string; name: string; trips: number }[];
}

export type ReportStatus = 'new' | 'in_review' | 'resolved' | 'rejected' | 'reopened';
export type ReportKind = 'wrong_info' | 'closed' | 'suggestion' | 'complaint';

export interface AdminReport {
  id: string;
  placeId: string;
  placeName: string;
  kind: ReportKind;
  message: string;
  status: ReportStatus;
  resolutionNote: string | null;
  createdAt: string;
}
