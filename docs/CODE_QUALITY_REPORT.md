# Code quality and architecture report (November 2026)

## Overall assessment

**Good.** About 9.5k lines, strict TypeScript, two documented React-hooks lint exceptions and no TypeScript suppressions, clean typecheck, and 133 automated tests plus three browser end-to-end suites.

What already works well:
- **Contract-first frontends:** screens only see `UserApi` / `AdminApi`, so the mock and the HTTP API are interchangeable.
- **Server-owned scheduling:** clients send only the order of places; the server computes times, travel and breaks.
- **One error shape** across the API.
- **Feature folders** in both apps.
- **Comments that explain why,** often citing the review item they came from.

The weaknesses are mostly duplication, a few hot paths, and documentation that drifted.

## Fixed in this pass

| Issue | Where | Change |
| --- | --- | --- |
| N+1 queries listing trips (~6 per trip, plus the city's places reloaded per trip) | `apps/api/src/modules/trips.ts` | `loadTrips` batches each table and loads each city once (finding S4) |
| The same wish-list query in 5 places, the preferences upsert in 2, the profile query in 2 | `trips.ts`, `passport.ts`, `auth.ts` | `lib/users.ts` (`wishListOf`, `profileOf`) and `rememberPreferences` |
| Database pool and TLS setup written twice | `server.ts`, `db/cli.ts` | `openDb()` in `db/client.ts` |
| Docs drift: "tokens live in localStorage", "approximate prayer times", old test counts, old lockout rule | `docs/ARCHITECTURE.md`, `README.md`, `docs/BACKEND.md` | Corrected |
| Deploy command was missing the new required setting | `docs/LAUNCH.md` | `TRUST_PROXY` added and explained |
| `sub!` non-null assertion on the token subject | `auth/session.ts` | Validated (`typeof sub === 'string'`) instead |

## Recommended, not done (and why)

| # | Issue | Where | Recommendation | Why not now |
| --- | --- | --- | --- | --- |
| Q1 | The two sign-in forms (web sheet, admin gate) are near copies | `apps/web/src/features/auth/SignInSheet.tsx`, `apps/admin/src/app/AdminGate.tsx` | Move a shared `SignInForm` with copy passed as props into `@riflo/ui` | Touches UI in both apps; deserves its own visual review |
| Q2 | Six API test files each define their own `inject` / sign-in helpers | `apps/api/test/*.ts` | A shared `test/harness.ts` | A large test-only diff with no product benefit; do it next time tests are touched |
| Q3 | `TripPage` hard-codes `'madinah'` when loading places | `apps/web/src/features/trip/TripPage.tsx:18` | Use `trip.preferences.cityId` | Fine while only Madinah is active; must change before a second city |
| Q4 | Large components: `TripPage` (314 lines), `CreateTripPage` (267), `planner.ts` (423) | — | Split `TripView` into day editor / left-out list / budget; split the planner into ranking, layout and validation files | Readable today; splitting risks regressions in the most-tested logic. Do it when next changing them |
| Q5 | Unused schema: `trips.status` (never changes, yet `/v1/admin/insights` groups by it), `users.phone`, `cities.name_en`, `place_photos` (no write path) | migrations 001 | Remove or use them in a new migration | Schema changes need your approval; `phone` and `place_photos` are planned features (LAUNCH.md) |
| Q6 | Admin user-management endpoints exist but the admin app has no screen for them | `modules/admin.ts`, `packages/core/src/api/contract.ts` | Add a Users page | Feature work |
| Q7 | Place search and category filter run in JavaScript after loading every published place of a city | `modules/places.ts:21-28` | Filter in SQL (and use `ILIKE`) once content grows | Hundreds of places today; not yet a bottleneck |
| Q8 | No pagination on admin lists (LIMIT 200/1000) | `modules/admin.ts` | Cursor pagination | Already noted in LAUNCH.md §6 |
| Q9 | The API runs through `tsx` in production | `apps/api/package.json` | Build to `dist/` (finding S7) | Changes the deploy procedure |
| Q10 | No linter or formatter configured | root | Add ESLint (typescript-eslint, react-hooks) and Prettier with the current style | New dependencies; agree on rules first |
| Q11 | Four separate "fix" logs in `docs/` | `docs/*_FIX*.md` | Keep as history; new changes go in `CHANGELOG.md` | Done going forward |

## Architecture notes

- **Layering.** API route modules mix HTTP parsing, rules and SQL. At the current size (≤ 270 lines per module) this is readable. When a module passes ~400 lines, extract a `repo` (SQL) layer per area first, since that's where the reuse is.
- **Shared planner.** Running the same `@riflo/core` planner on the client (instant edit feedback) and the server (authority) is a good choice. The server must stay the authority, as it is now.
- **Scaling.**
  - The API is stateless apart from the database and Redis, so it scales horizontally.
  - Rate limits need Redis with more than one instance (enforced in production).
  - The quota checks use advisory locks, which are correct across instances.
  - The next likely hot spot is `/v1/plans` (CPU-bound planner). It is rate-limited per IP, and since S1 is fixed, those limits can't be bypassed.
