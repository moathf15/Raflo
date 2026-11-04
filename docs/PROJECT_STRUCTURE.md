# Project structure

RIFLO is an npm-workspaces monorepo: three apps and two shared packages. Data flows in one direction:

```
apps/web, apps/admin  ──(UserApi / AdminApi from @riflo/core)──▶  apps/api  ──(parameterised SQL)──▶  PostgreSQL
        │                                                           │
        └──── @riflo/ui (look)         @riflo/core (domain) ◀───────┘  (the API reuses the same planner and types)
```

## Top level

| Path | Responsibility |
| --- | --- |
| `package.json` | Workspaces and root scripts (`dev:*`, `build`, `test`, `typecheck`) plus shared build tooling (TypeScript, Vite) |
| `tsconfig.base.json` | Strict compiler settings that every workspace extends |
| `README.md` | What the project is and how to run it in one minute |
| `CHANGELOG.md` | Every important change, with the reason and impact |
| `docs/` | Architecture, backend reference, launch checklist, audits (see below) |
| `ops/db/` | Production database roles (`roles.sql`) and the backup and restore check (`backup.sh`) |
| `tests/e2e/` | Full-system browser tests: they build both apps, start the API and drive Chromium |

## `apps/api` — REST API (Fastify + PostgreSQL)

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | Process entry: loads config, opens the database, migrates or seeds as configured, listens, shuts down cleanly |
| `src/app.ts` | Builds the Fastify app: security plugins (helmet, CORS, rate limit), error handler, stale-cookie hook, `/health`, route modules, hourly cleanup. Tests call `buildApp` directly |
| `src/config.ts` | Every environment variable, validated with zod, with **production refusal rules** (`loadConfig`) and `trustProxySetting` |
| `src/context.ts` | What route modules receive (`Ctx`), plus shared helpers: `audit` (admin audit log), `track` (analytics), `QUOTAS`, `withQuota` / `lockKey` (race-free quota checks) |
| `src/auth/session.ts` | Sessions: code generation and hashing, token signing, cookie handling, CSRF Origin check, `optional` / `required` / `role` guards |
| `src/modules/auth.ts` | Sign-in (request code, verify for browsers or native apps), logout, `/v1/session`, `/v1/me` (read, rename, delete) and the lockout tiers |
| `src/modules/places.ts` | Public content: cities, published places, place details, guest reports. Exports `publishedPlaces` |
| `src/modules/trips.ts` | Plan generation, saved trips (create, edit, delete), trip selection (`trip_places`), batch loading (`loadTrips`) |
| `src/modules/passport.ts` | Passport summary, visits (stamps), wish list, client analytics events |
| `src/modules/admin.ts` | Staff: place editing and publishing, report workflow, overview metrics, insights. Admin only: user roles and status |
| `src/lib/http.ts` | `HttpError` and the one error shape `{ error: { code, message } }`; maps PostgreSQL client errors to 4xx |
| `src/lib/schemas.ts` | zod schemas for request bodies (preferences, trips, places, events) |
| `src/lib/mappers.ts` | Database rows (snake_case) → API types (camelCase) |
| `src/lib/users.ts` | Small shared user queries (`profileOf`, `wishListOf`) |
| `src/lib/email.ts` | Mailer: SMTP in production, a log-only mailer in development. Logs hash addresses and never contain codes |
| `src/db/client.ts` | The `Db` interface (query, exec, tx) and its two implementations (PostgreSQL pool, PGlite), plus `openDb` |
| `src/db/migrate.ts` | Applies `migrations/*.sql` in order, each in a transaction, recorded in `schema_migrations` |
| `src/db/migrations/` | The schema. **Never edit an applied migration; add a new numbered file** |
| `src/db/seed.ts` | Madinah sample content and a local admin (development only; refused in production) |
| `src/db/cli.ts` | `npm run migrate`, `seed`, `create-admin` |
| `test/*.test.ts` | API tests (node:test + `app.inject`) on PGlite, or a real PostgreSQL via `TEST_DATABASE_URL`. `security-audit.test.ts` holds this audit's regressions |

## `apps/web` — traveller app (React, mobile first, RTL)

| Path | Responsibility |
| --- | --- |
| `src/main.tsx` | Entry; refuses to run a production build that has no API configured |
| `src/app/App.tsx` | Routes |
| `src/app/services.tsx` | Picks the HTTP API or the mock; holds the signed-in user, sign-in sheet, draft trip, toast |
| `src/app/AppShell.tsx` | Page frame, top bar, bottom navigation |
| `src/features/home` | Home: next trip, suggestions |
| `src/features/create-trip` | The 3-step planner form |
| `src/features/trip` | Trip view and editing (`TripPage`), schematic route map (`DayMap`) |
| `src/features/places` | Place details sheet (visit, wish list, report) and text helpers |
| `src/features/passport` | Passport: stamps, stats, wish list |
| `src/features/explore` | Browse and filter places |
| `src/features/auth` | Email → code sign-in sheet |
| `src/i18n/` | All Arabic copy |
| `src/lib/format.ts` | Clock, money and date formatting |

## `apps/admin` — staff dashboard (React, desktop first)

| Path | Responsibility |
| --- | --- |
| `src/main.tsx` | Entry and routes, wrapped in `AdminGate` |
| `src/app/AdminGate.tsx` | Sign-in and the editor/admin check (UI only; the API enforces roles) |
| `src/app/AdminShell.tsx`, `services.tsx` | Layout; API selection and toast |
| `src/features/overview` | KPIs, funnel, top places |
| `src/features/content` | Place board and `PlaceEditor` (with publish checks) |
| `src/features/reports` | Report workflow (in review → resolved / rejected) |
| `src/i18n/ar.ts` | All Arabic copy |

## `packages/core` — domain logic shared by the apps and the API

| Path | Responsibility |
| --- | --- |
| `src/types.ts` | Place, Trip, TripDay, Stop, Visit, Passport, admin types |
| `src/planner.ts` | Ranking, day grouping, route ordering, scheduling with opening hours and prayer breaks, validation of manual edits, "could not fit" explanations, budget estimate |
| `src/prayer.ts` | Prayer times per city and date (`adhan`) |
| `src/geo.ts` | Distance and travel-time estimate |
| `src/content.ts` | Publishing rules (`publishProblems`), staleness, `todayIn` |
| `src/api/contract.ts` | `UserApi`, `AdminApi`, `ApiError`: the only way screens reach data |
| `src/api/http.ts` | Implementation against the RIFLO API (cookie session) |
| `src/api/mock.ts`, `storage.ts` | In-browser implementation for development and previews |
| `src/data/sample.ts` | Approximate Madinah sample places |
| `test/` | Planner tests |

## `packages/ui` — design system

`src/styles/` holds the design tokens, base styles and component styles. `src/components/` holds Button, Chip, StopCard, Sheet, Toast, the empty/error states and others. `src/hooks/useAsync.ts` gives every async screen its three states. `csp.ts` is the Vite plugin that adds the Content-Security-Policy to built apps.

## `docs/`

| File | Content |
| --- | --- |
| `ARCHITECTURE.md` | Frontend principles |
| `BACKEND.md` | Database tables, endpoint list, security model |
| `LAUNCH.md` | External services, deployment commands, pre-launch checklist |
| `DEVELOPER_GUIDE.md` | How to run, navigate and extend the code |
| `SECURITY_AUDIT.md` | November 2026 audit: findings, fixes, open risks |
| `CODE_QUALITY_REPORT.md` | Code quality and architecture review |
| `SECURITY_AUDIT_FIXES.md`, `REVIEW_2_FIXES.md`, `MANUAL_EDIT_FIX.md`, `SELECTION_FIX.md` | Historical records of earlier reviews (kept as written) |

## Before and after this audit

The layout was already well organised, so the refactor did not move folders. The changes:

```
apps/api/src/
  lib/users.ts                 + new: shared user queries (were repeated in 3 modules)
  db/client.ts                 ~ openDb(): one database factory for server.ts and db/cli.ts
apps/api/test/
  security-audit.test.ts       + new: regressions for S1–S5, S9
docs/
  SECURITY_AUDIT.md            + new
  CODE_QUALITY_REPORT.md       + new
  PROJECT_STRUCTURE.md         + new
  DEVELOPER_GUIDE.md           + new
CHANGELOG.md                   + new
```
