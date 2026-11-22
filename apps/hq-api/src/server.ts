import { buildApp } from './app';
import { createHq } from './bootstrap';
import { loadConfig } from './config';

const cfg = loadConfig();
const { ctx, db, worker, setupCode } = await createHq(cfg);
let code = setupCode;
const app = await buildApp(ctx, {
  setupCode: () => {
    // Valid only while no owner exists.
    return code;
  }
});
app.addHook('onResponse', async (req, reply) => {
  if (code && req.url === '/hq/v1/auth/setup' && reply.statusCode === 200) code = null;
});
if (cfg.HQ_WORKER) await worker.start();
await app.listen({ port: cfg.HQ_PORT, host: '0.0.0.0' });
if (code) app.log.warn(`No owner exists yet. Open the HQ and create the owner account with setup code: ${code}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await worker.stop();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
