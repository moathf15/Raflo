import type { LatLng } from './types';

const EARTH_KM = 6371;

/** Great-circle distance in km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Rough city driving estimate: road distance ≈ 1.3 × straight line, 30 km/h
 * average including traffic and parking, minimum 5 minutes.
 * A routing API can replace this later without changing callers.
 */
export function travelMinutes(km: number): number {
  return Math.max(5, Math.round(((km * 1.3) / 30) * 60));
}
