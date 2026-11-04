import type { Role } from '../auth/session';
import type { Db } from '../db/client';

/** Small queries about one user, shared by several route modules. */

export interface Profile {
  id: string;
  email: string;
  displayName: string | null;
  role: Role;
}

/** The public profile of a user, or null if the account no longer exists. */
export async function profileOf(db: Db, userId: string): Promise<Profile | null> {
  const [row] = await db.query<{ id: string; email: string; display_name: string | null; role: Role }>('SELECT id, email, display_name, role FROM users WHERE id = $1', [userId]);
  return row ? { id: row.id, email: row.email, displayName: row.display_name, role: row.role } : null;
}

/** The places on a user's wish list, oldest first. */
export const wishListOf = async (db: Db, userId: string) =>
  (await db.query<{ place_id: string }>('SELECT place_id FROM wishlist WHERE user_id = $1 ORDER BY created_at', [userId])).map((r) => r.place_id);
