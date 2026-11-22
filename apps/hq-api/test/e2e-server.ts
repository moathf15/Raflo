/**
 * END-TO-END TEST SERVER ONLY. Starts the real HQ API and frontend with a scripted AI provider and a fake GitHub
 * API so browser tests can run without credentials or network. Never used by `npm start`.
 */
import { buildApp } from '../src/app';
import { createHq } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { createVault } from '../src/lib/crypto';
import { openDb } from '../src/db/client';
import { call, defaultAnswer, fakeGitHub, scriptedProvider } from './helpers';

const port = Number(process.env.E2E_PORT ?? 8099);
const cfg = loadConfig({
  NODE_ENV: 'test',
  HQ_PORT: String(port),
  HQ_PUBLIC_URL: `http://localhost:${port}`,
  COOKIE_SECURE: 'false',
  HQ_STATIC_DIR: process.env.HQ_STATIC_DIR ?? '../hq/dist'
});
const db = await openDb(cfg, { url: undefined, max: 1, statementTimeoutMs: 10_000, pgliteDir: process.env.E2E_DB });
const delay = Number(process.env.E2E_DELAY_MS ?? 700);
const gh = fakeGitHub();
let n = 0;
const hq = await createHq(cfg, {
  db,
  vault: createVault(Buffer.alloc(32, 9)),
  githubFetch: gh.fetch,
  workerIntervalMs: 300,
  providerFactory: () =>
    scriptedProvider((req) => {
      n++;
      const has = (x: string) => req.tools.some((t) => t.name === x);
      const text = JSON.stringify(req.messages);
      // The frontend developer reads real (fake-GitHub) code before proposing a change.
      if (has('github_propose_change') && !text.includes('Change proposal') && text.includes('trip planning')) {
        if (!text.includes('<untrusted')) return call('github_read_file', { path: 'apps/web/src/features/trip/TripPage.tsx' });
        return call('github_propose_change', {
          title: 'Clearer trip day headers',
          description: 'Adds a heading for each day of the trip.',
          files: [{ path: 'apps/web/src/features/trip/TripPage.tsx', content: 'export function TripPage() {\n  return <h2>Day 1</h2>;\n}\n' }]
        });
      }
      if (has('contribute')) {
        const lines = ['I propose we focus on the onboarding flow first.', 'I disagree — search friction is bigger for Arabic users.', 'Agreed on onboarding, with an Arabic-first review.'];
        return call('contribute', { message: lines[n % 3], stance: n % 3 === 1 ? 'disagree' : 'proposal', addressed_to: [], wants_to_continue: false });
      }
      return defaultAnswer(req);
    }, [])
});
// Slow the scripted provider down so the office animations are observable.
const factory = hq.ctx.providers.forEmployee.bind(hq.ctx.providers);
hq.ctx.providers.forEmployee = async (e) => {
  const p = await factory(e);
  return { ...p, chat: async (r, s) => (await new Promise((ok) => setTimeout(ok, delay)), p.chat(r, s)) };
};
const app = await buildApp(hq.ctx, { setupCode: () => (process.env.E2E_SETUP_CODE ?? hq.setupCode) });
// Fixed setup code for the browser test.
if (hq.setupCode) (hq as { setupCode: string | null }).setupCode = process.env.E2E_SETUP_CODE ?? hq.setupCode;
await hq.worker.start();
await app.listen({ port, host: '127.0.0.1' });
console.log(`E2E HQ on http://localhost:${port}`);
