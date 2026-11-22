# Raflo AI HQ

A headquarters for a company run by AI employees. The owner (CEO) manages a 20-person AI workforce through a
game-like office and conventional productivity views. Every animation, transcript line, metric and deliverable
comes from stored execution records; nothing is simulated.

HQ is isolated from the Raflo product: its own API (`apps/hq-api`), frontend (`apps/hq`) and `hq_*` tables. It
reuses the repository's stack (npm workspaces, Fastify 5, PostgreSQL/PGlite, zod, React 18, Vite, node:test,
Playwright) and the RIFLO palette and fonts. The existing apps are unchanged.

| Document | What it covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, data model, orchestration engine, meetings, GitHub flow |
| [MILESTONES.md](MILESTONES.md) | The six milestones: acceptance criteria, tests and review report for each |
| [SECURITY.md](SECURITY.md) | Authentication, permissions, approval gates, credentials, prompt injection |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Environment variables, production setup, GitHub App, backups |

## Run it locally

```bash
npm install
npm run dev:hq-api          # API on :8090, PGlite in apps/hq-api/.data/hq (persistent). Prints a one-time setup code.
npm run dev:hq              # Frontend on http://localhost:5180 (proxies /hq/v1 to the API)
```

1. Open http://localhost:5180 and create the owner account with the setup code from the API log.
2. **Settings → AI providers**: add an Anthropic (or OpenAI) key and press *Test connection*. Until a provider
   exists, employees do not run: tasks are blocked with "No AI provider is configured".
3. **GitHub**: connect (OAuth if `GITHUB_CLIENT_ID/SECRET` are set, otherwise a fine-grained token) and authorise
   `moathf15/Raflo`.
4. Office → click an employee → *Assign task*, or *Give an objective* to the Chief of Staff.

Single process (API serves the built frontend): `npm run start:hq`, then open http://localhost:8090.

## Tests

```bash
npm test -w @riflo/hq-api   # 29 integration tests (PGlite, scripted test provider, fake GitHub API)
tests/e2e/run-hq.sh          # browser end-to-end: setup → provider → GitHub → task → diff approval → meeting → dashboard → Arabic → keyboard → phone
npm run typecheck
```

The scripted provider and fake GitHub exist only under `apps/hq-api/test/`. The production server
(`src/server.ts`) only builds real Anthropic/OpenAI clients from stored, encrypted keys.
