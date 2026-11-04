import type { AdminOverview, AdminReport, Passport, PassportStats, Place, PlaceStatus, ReportStatus, Trip, TripPreferences, Visit } from '../types';

export type Role = 'user' | 'editor' | 'admin';

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: Role;
}

/** Sign-in with a one-time code. The mock is always signed in as a local, on-device user. */
export interface AuthApi {
  /** True when actions like saving need a real account (HTTP). False for the mock. */
  readonly requiresAccount: boolean;
  current(): Promise<SessionUser | null>;
  /** `devCode` is only returned by a development server. */
  requestCode(email: string): Promise<{ devCode?: string }>;
  verify(email: string, code: string): Promise<SessionUser>;
  /** Revokes the session on the server and clears the cookie. */
  signOut(): Promise<void>;
}

export type ClientEvent = 'plan_started' | 'plan_step_completed';

/**
 * The only way screens talk to data. `createMockApi` (in-browser) and
 * `createHttpApi` (the RIFLO API) both implement it.
 */
export interface UserApi {
  auth: AuthApi;
  /** Start a planning attempt. Funnel events, the plan and the saved trip share its id, so the
   *  completion rate counts real attempts rather than unrelated events (audit 5.7). */
  startPlanSession(): void;
  /** Allowed props: plan_started → { cityId }, plan_step_completed → { step: 1..3 }. */
  track(name: ClientEvent, props?: { cityId?: string; step?: number }): void;

  listPlaces(cityId: string): Promise<Place[]>;
  getPlace(id: string): Promise<Place | null>;

  createPlan(preferences: TripPreferences, title: string): Promise<Trip>;
  getTrip(id: string): Promise<Trip | null>;
  listTrips(): Promise<Trip[]>;
  /** Unsaved trips are created; saved ones (`trip.saved`) are updated. */
  saveTrip(trip: Trip, reusedFrom?: string): Promise<Trip>;
  deleteTrip(id: string): Promise<void>;
  /** Remove a place from a saved trip's selection (it must not be in a day). Returns the trip as the server sees it. */
  removeFromTrip(tripId: string, placeId: string): Promise<Trip>;

  getPassport(): Promise<Passport>;
  getPassportStats(): Promise<PassportStats>;
  /** Self-reported: the server rejects future dates and places that aren't in the given trip. */
  logVisit(visit: Omit<Visit, 'id' | 'source'>): Promise<Visit>;
  updateVisit(id: string, changes: { rating: number | null; note: string }): Promise<Visit>;
  deleteVisit(id: string): Promise<void>;
  toggleWish(placeId: string): Promise<string[]>;
  reportPlace(placeId: string, message: string): Promise<void>;
}

export interface AdminApi {
  auth: AuthApi;
  listPlaces(cityId: string): Promise<Place[]>;
  /** Places with an empty `updatedAt` are new and get created. */
  savePlace(place: Place): Promise<Place>;
  /** Publishing a place with missing data fails with code `place_incomplete`. */
  setStatus(id: string, status: PlaceStatus): Promise<Place>;
  getOverview(cityId: string): Promise<AdminOverview>;
  listReports(status: 'open' | ReportStatus): Promise<AdminReport[]>;
  /** Resolving or rejecting needs a note saying why. */
  updateReport(id: string, status: ReportStatus, note?: string): Promise<AdminReport>;
}

export type ApiErrorCode = 'network' | 'not_found' | 'invalid' | 'unauthorized' | 'forbidden' | 'conflict' | 'rate_limited' | 'server';

export class ApiError extends Error {
  constructor(message: string, readonly code: ApiErrorCode) {
    super(message);
  }
}
