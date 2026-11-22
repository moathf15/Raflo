# RIFLO

A Saudi trip-planning platform, launching in Madinah. This repository holds the user app, the admin dashboard and the API, connected and tested end to end. Before launch, see [docs/LAUNCH.md](docs/LAUNCH.md).

## Run it

Requires Node 18+.

```bash
npm install
# Full system, locally
AUTH_DEV_CODES=true npm run dev:api                    # API → http://localhost:8080 (in-memory Postgres + Madinah sample content)
VITE_API_URL=http://localhost:8080 npm run dev:web     # user app → http://localhost:5173
VITE_API_URL=http://localhost:8080 npm run dev:admin   # admin    → http://localhost:5174 (sign in as admin@riflo.local)

# Apps alone, without the API (in-browser mock data; dev only, or VITE_ALLOW_MOCK=true for demo builds)
npm run dev:web
npm run dev:admin

npm test               # 32 planner + 101 API tests (PGlite; set TEST_DATABASE_URL for real PostgreSQL)
tests/e2e/run.sh       # full-system test in a browser (needs Playwright)
npm run typecheck
```

With `AUTH_DEV_CODES=true` the sign-in code is shown on screen instead of being emailed. Never use it in production.

See [CHANGELOG.md](CHANGELOG.md) for what changed and why.

## Raflo AI HQ

An AI-workforce headquarters for running Raflo (virtual office, real AI employees, meetings, GitHub workflow with approval gates). Isolated in `apps/hq-api` and `apps/hq`; see [docs/hq/README.md](docs/hq/README.md).

```bash
npm run dev:hq-api   # API :8090 (prints a one-time owner setup code)
npm run dev:hq       # UI  http://localhost:5180
```

## Layout

```
apps/
  web/        User app (mobile first, Arabic RTL)
  admin/      Admin dashboard (desktop first), separate app and bundle
  api/        REST API (Fastify + PostgreSQL), migrations, tests
  hq-api/     Raflo AI HQ: agent orchestration API and worker
  hq/         Raflo AI HQ: virtual office frontend
packages/
  core/       Domain types, trip planner, API contract, mock API, sample data
  ui/         RIFLO design-system tokens, base styles and shared components
docs/
  ARCHITECTURE.md   How the frontend is organised
  BACKEND.md        Database, API, security and what plugs in next
  LAUNCH.md         External services, deployment, pre-launch checklist
  SECURITY_AUDIT_FIXES.md   How each audit finding was fixed and tested
  REVIEW_2_FIXES.md         Second review: concurrency, bearer path, multi-day planner
  MANUAL_EDIT_FIX.md        Manual scheduling: edits validated like generated plans
  SELECTION_FIX.md          A trip's chosen places kept by the server
  SECURITY_AUDIT.md         Security audit (Nov 2026): findings, fixes, open risks
  CODE_QUALITY_REPORT.md    Code quality and architecture review
  PROJECT_STRUCTURE.md      What every folder and important file is for
  DEVELOPER_GUIDE.md        Running, navigating and extending the project
ops/db/             Database roles, backup and restore check
tests/
  e2e/              Full-system browser test
```
