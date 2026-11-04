import { loadConfig } from '../config';
import { openDb } from './client';
import { migrate } from './migrate';
import { seed } from './seed';

// npm run migrate                       apply pending migrations
// npm run seed                          migrations + Madinah sample content (local/staging only)
// npm run create-admin -- you@domain    migrations + grant admin to that email (production bootstrap)
const cfg = loadConfig();
const url = cfg.DATABASE_MIGRATION_URL ?? cfg.DATABASE_URL;
// Migrations may run long: a small pool and a 10-minute statement timeout.
const db = await openDb(cfg, { url, max: 2, statementTimeoutMs: 600_000, pgliteDir: cfg.PGLITE_DIR ?? './.data' });
const [cmd, arg] = process.argv.slice(2);

console.log('migrations applied:', await migrate(db));
if (cmd === 'seed') {
  if (cfg.NODE_ENV === 'production') throw new Error('Sample content is never loaded in production. Enter places through the admin.');
  await seed(db);
  console.log('seeded sample content');
}
if (cmd === 'create-admin') {
  const email = (arg ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('usage: npm run create-admin -- you@domain');
  await db.query(`INSERT INTO users (email, role) VALUES ($1, 'admin') ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`, [email]);
  console.log('admin ready:', email, '(sign in with an emailed code)');
}
await db.close();
