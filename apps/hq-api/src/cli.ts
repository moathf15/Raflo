import { loadConfig } from './config';
import { openDb } from './db/client';
import { migrate } from './db/migrate';
import { seedOrg } from './db/org';
import { hashPassword } from './lib/crypto';

// npm run migrate -w @riflo/hq-api                          apply migrations and seed the organisation
// npm run create-owner -w @riflo/hq-api -- you@domain       create (or reset the password of) an owner; password read from HQ_OWNER_PASSWORD
const cfg = loadConfig();
const db = await openDb(cfg, { url: cfg.DATABASE_URL, max: 2, statementTimeoutMs: 600_000, pgliteDir: cfg.HQ_PGLITE_DIR });
const [cmd, arg] = process.argv.slice(2);
console.log('migrations applied:', await migrate(db));
console.log('organisation seeded:', await seedOrg(db));
if (cmd === 'create-owner') {
  const email = (arg ?? '').trim().toLowerCase();
  const pw = process.env.HQ_OWNER_PASSWORD ?? '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('usage: HQ_OWNER_PASSWORD=… npm run create-owner -- you@domain');
  if (pw.length < 12) throw new Error('HQ_OWNER_PASSWORD must be at least 12 characters');
  await db.query(`INSERT INTO hq_owners (email, password_hash, role) VALUES ($1, $2, 'owner') ON CONFLICT (email) DO UPDATE SET password_hash = $2`, [email, await hashPassword(pw)]);
  await db.query(`UPDATE hq_sessions SET revoked_at = now() WHERE owner_id = (SELECT id FROM hq_owners WHERE email = $1)`, [email]);
  console.log('owner ready:', email);
}
await db.close();
