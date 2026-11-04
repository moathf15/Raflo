import { CITIES, SAMPLE_PLACES } from '@riflo/core';
import type { Db } from './client';

/** Load the Madinah sample content and an admin account. Safe to run twice. */
export async function seed(db: Db, adminEmail = 'admin@riflo.local') {
  for (const c of CITIES) {
    await db.query(`INSERT INTO cities (id, name_ar, lat, lng, timezone, active) VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (id) DO NOTHING`, [c.id, c.name, c.location.lat, c.location.lng, c.timezone]);
  }
  for (const p of SAMPLE_PLACES) {
    await db.query(
      `INSERT INTO places (id, city_id, name_ar, summary_ar, category, lat, lng, visit_minutes, cost_per_person, opening_hours, open_minute, close_minute, source, best_time, etiquette, status, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.cityId, p.name, p.summary, p.category, p.location.lat, p.location.lng, p.visitMinutes, p.costPerPerson, p.openingHours, p.hours?.open ?? null, p.hours?.close ?? null, 'sample data (unverified)', p.bestTime, p.etiquette, p.status, p.updatedAt]
    );
  }
  await db.query(`INSERT INTO users (email, display_name, role) VALUES ($1, 'RIFLO Admin', 'admin') ON CONFLICT (email) DO NOTHING`, [adminEmail]);
}
