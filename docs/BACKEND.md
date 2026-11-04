# Backend, database and API

## Decisions

| Area | Choice | Why |
| --- | --- | --- |
| Database | PostgreSQL 15+ | Relational data (trips → days → stops), strong constraints, arrays/JSONB for preferences and analytics, PostGIS available when distance queries move into SQL. Offered by Saudi cloud regions (data residency). |
| Dev/test database | PGlite (Postgres in WASM) | The same migrations run in tests and locally without installing a server. |
| API | Node 20 + TypeScript + Fastify, REST under `/v1` | Shares `@riflo/core` (types and planner) with the apps, so the plan a user sees is computed by the same code. |
| Validation | zod on every body and query | One error shape: `{ error: { code, message, issues? } }`. |
| Sign-in | 6-digit one-time code by email, then a server-side session (HttpOnly cookie for browsers) | No passwords to leak; sessions can be revoked one by one or all at once. SMS (Unifonic/Taqnyat) plugs into the same two endpoints. |
| Roles | `user`, `editor` (content), `admin` (content + users) | Role and status are re-read on every request, so suspension is immediate. |
| Trip storage | Client sends **place order per day**; server computes times, travel and prayer breaks | Clients cannot store impossible schedules; planner changes apply everywhere. |

## Data model

See the ER diagram in FigJam and `apps/api/src/db/migrations/` (`001_init.sql`, `002_security_audit.sql`).

- **cities / places / place_photos** — content. `cities.timezone` drives prayer times and "today". `places.status`: `draft → review → published ↔ hidden`. Opening hours are stored as `open_minute`/`close_minute` (used by the planner) plus display text; `source` and `verified_at` record where the data came from. Unknown cost or hours are `NULL`, never a guess.
- **users / login_codes / auth_failures / sessions** — accounts; hashed one-time codes (10-minute expiry, 5 attempts, single use, a new code invalidates older ones); failed attempts per email and IP for progressive lockout; server-side sessions (revocable).
- **trips / trip_days / trip_stops** — saved plans. `trips.reused_from` records "use it again".
- **visits** — the Passport stamps (one per place per day, optional rating and note). `source` is `self_reported` until a verification method exists.
- **wishlist** — places to visit later; removed automatically when visited.
- **user_preferences** — the last preferences (without dates) that pre-fill the next trip.
- **reports** — visitor reports: `new → in_review → resolved | rejected` (a note is required), can be `reopened`. Publishing a place never closes reports.
- **events** — funnel analytics, grouped by a planning `session_id` (`plan_started`, `plan_step_completed`, `plan_ready`, `trip_saved`, `plan_reused`, `visit_logged`); guests use `anonymous_id`.
- **audit_log** — every editor/admin change with before/after values, written in the same transaction as the change. Append-only (a trigger blocks edits and deletes). A second trigger keeps at least one active admin.

## API

Browsers sign in with a cookie only (`riflo_session`, HttpOnly, Secure, SameSite=Lax); every cookie-authenticated write must come from an allowed `Origin`. Native apps use a separate endpoint, `POST /v1/auth/native/verify`, which exists only when `NATIVE_CLIENTS=true`, refuses any request carrying `Origin`/`Sec-Fetch-Site` (so no web page can use it), and returns a token for `Authorization: Bearer`. Each session is bound to the transport it was issued for.

| Method | Path | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/request-code` | anyone | Send a code. Per email: 60 s cooldown, 5 / hour; per IP rate limit; locked emails refused |
| POST | `/v1/auth/verify` | anyone | Code → cookie session. Each guess reserves one of 5 attempts atomically before comparing; repeated failures against a live code lock sign-in: 10 from one IP → 15 min for that email+IP; 20 from any IPs → 1 h; 30 → 24 h for the email |
| POST | `/v1/auth/native/verify` | native apps (`NATIVE_CLIENTS=true`) | Code → bearer token; refused from browsers |
| POST | `/v1/auth/logout`, `/v1/auth/logout-all` | user | End this session / every session |
| GET | `/v1/session` | anyone | `{ user }` or `{ user: null }` for guests (used by the apps because the cookie is unreadable to scripts) |
| GET / PATCH / DELETE | `/v1/me` | user | Profile, display name, delete account (PDPL erasure) |
| GET | `/v1/cities` | anyone | Active cities (with time zone) |
| GET | `/v1/cities/:cityId/places?category=&q=` | anyone | Published places |
| GET | `/v1/places/:id` | anyone | Place + photos |
| POST | `/v1/places/:id/reports` | anyone (10 / hour) | Report a published place |
| POST | `/v1/plans` | anyone (30 / 10 min) | Generate a plan (not saved) |
| GET / POST | `/v1/trips` | user (30 / day, 200 total) | List / save a trip; `reusedFrom` must be your own trip |
| POST / DELETE | `/v1/trips/:id/places`, `/v1/trips/:id/places/:placeId` | owner | Choose a place for the trip / remove it from the trip (explicit) |
| GET / PUT / DELETE | `/v1/trips/:id` | owner | Read / edit / delete. On save every day is laid out again and must fit; otherwise `400 day_not_executable` with `problems: [{ date, placeId, problem }]` (`outside_hours`, `closed_that_day`, `past_day_end`) and nothing is saved. The left-out list is rebuilt by the server |
| GET | `/v1/passport` | user | Visits, wish list, last preferences, stats |
| POST / PATCH / DELETE | `/v1/visits`, `/v1/visits/:id` | user (50 / day) | Log, edit or remove a stamp. Not in the future, not older than 365 days; with a trip, the place and date must belong to it |
| PUT / DELETE | `/v1/wishlist/:placeId` | user (300 max) | Save / unsave a place |
| POST | `/v1/events` | anyone (2 KB body, 300 / day) | Allowlisted client events with strict properties |
| GET | `/v1/admin/cities/:cityId/places` | editor, admin | All places, any status, with open-report counts |
| POST / PUT | `/v1/admin/places`, `/v1/admin/places/:id` | editor, admin | Create (as draft) / edit |
| PATCH | `/v1/admin/places/:id/status` | editor, admin | Publish (refused with `missing` if summary, hours, cost, duration or location is incomplete), hide, review |
| GET / PATCH | `/v1/admin/reports`, `/v1/admin/reports/:id` | editor, admin | Review reports through their lifecycle |
| GET | `/v1/admin/overview?cityId=&days=` | editor, admin | Decisions, KPIs, funnel, top places |
| GET | `/v1/admin/insights?cityId=` | editor, admin | Most-planned places, top interests, trips by status |
| GET / PATCH | `/v1/admin/users`, `/v1/admin/users/:id` | admin | Search users, change role or suspend (revokes their sessions; not yourself; never the last admin) |

KPI definitions (all for the selected period):

- **Registered users**: accounts created. **Active users**: users with any trip, visit or event.
- **Trips created**: saved trips.
- **Plan completion**: planning sessions that reached `plan_ready` ÷ sessions that sent `plan_started` (same `session_id`).
- **Return rate**: users whose first trip is at least 90 days old and who created another trip within 90 days of it. Shown as "—" until such users exist.

## Planner rules (`packages/core/src/planner.ts`)

- One day per date. Each day has a window: 09:00–21:00, shortened on the first day by a late arrival (`firstDayStart`) and on the last by an early departure (`lastDayEnd`).
- Wanted places (chosen interests + wish list) are allocated one at a time to the day with the lowest **time load** (time used ÷ time available), so short days get fewer stops; with fewer places than days they are spread out. Places outside the chosen interests are not added to fill days.
- Every insertion is laid out for real (route order, opening hours, weekday closures, prayers, day end); if it does not fit, the next day is tried. A geography pass then swaps places between days when that shortens travel without unbalancing the days.
- **Source of truth for a trip's places: `trip_places`** (migration 006). Filled when the trip is created (its interests, the wish list at that moment, the scheduled places, and left-out ids the client lists if published), then changed only by the server: scheduling a place in a day adds it; `POST /v1/trips/:id/places` chooses one without a day; `DELETE /v1/trips/:id/places/:placeId` removes one (409 while it is in a day). Removing a place from a day does not un-choose it. On edits the client's `unscheduled`/`excluded` fields are ignored. Trips return `selected`.
- Places left out are returned in `unscheduled`, computed on every read from `trip_places` and the days (never stored): `not_added` + `canFitOn` (a day where it fits as the days are now), or `closed_on_trip_days`, `longer_than_day`, `no_time_left`, or `unavailable` (chosen but no longer published). Generated plans and edited trips use the same function (`explainUnscheduled`); on save the server rebuilds the list from the trip's interests, the wish list and the listed ids — the client cannot set it.
- Manual edits are checked like generated plans (`validateDays`): the app refuses an edit that breaks a day and offers another day (`suggestDay`); the API refuses to save one; the mock API applies the same rule. Closing weekdays require opening hours (database constraint).
- Prayer times by date from the Umm Al-Qura method (`adhan`), in the city's time zone. A prayer due during travel is taken before travelling; while waiting for opening, while waiting; during a visit, it pauses the visit (inside the mosque at a mosque). Each break records its `phase` so the app shows the day in time order.
- Nothing overlaps, nothing starts before the window or ends after it, no visit outside the opening hours or on a closed weekday, no place twice in a day, at most 3 (relaxed) or 4 stops a day.
- Interests are balanced round-robin; each day is routed nearest-neighbour + 2-opt.
- Budget shows entry and transport separately and counts places with unknown cost.

## Security and privacy

- Codes hashed, compared in constant time, consumed with a conditional update (works once even under races). Failed attempts are recorded outside the transaction so they are never rolled back.
- Helmet (API CSP `default-src 'none'`), CORS allowlist with credentials, 64 KB body limit, request timeouts, parameterised SQL only, `authorization`/`cookie` headers redacted from logs, codes never logged.
- Ownership enforced in SQL (`WHERE user_id = $me`): other users' records return 404.
- Rate limits are shared across instances through Redis (`REDIS_URL`). Per-user quotas and per-email code limits are checked and written in one transaction under an advisory lock, so parallel requests cannot overshoot them. Admin demotions are serialized by a lock in the `keep_one_admin` trigger.
- Database: TLS with certificate verification, pool and statement timeouts, separate roles for migrations (`riflo_owner`) and the API (`riflo_app`) — see `ops/db/roles.sql`.
- Production refuses to start with a weak or default `JWT_SECRET`, dev codes on, no SMTP, non-HTTPS CORS origins, no `DATABASE_URL`, or no Redis (unless `RATE_LIMIT_STORE=memory` is set explicitly for a single instance).
- PDPL: minimal personal data; account deletion cascades to trips, visits, wish list, preferences and sessions; reports and events are kept without the user link.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | PGlite in memory | Required in production; connect as `riflo_app` |
| `DATABASE_MIGRATION_URL` | `DATABASE_URL` | Connect as `riflo_owner` for `npm run migrate` |
| `DATABASE_SSL`, `DATABASE_SSL_CA` | on in production | CA file path for providers with private CAs |
| `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS` | 10, 5000 | |
| `MIGRATE_ON_START` | false in production | Run migrations as a separate deploy step |
| `JWT_SECRET` | dev value | 48+ random characters in production |
| `SESSION_TTL_DAYS` | 30 | |
| `COOKIE_SECURE`, `COOKIE_DOMAIN` | on in production | e.g. `.riflo.sa` to share across subdomains |
| `CORS_ORIGINS` | local dev ports | Comma-separated, HTTPS only in production |
| `EMAIL_PROVIDER`, `SMTP_URL`, `EMAIL_FROM` | `log` | `smtp` required in production |
| `AUTH_DEV_CODES` | false | Returns codes in responses; refused in production |
| `NATIVE_CLIENTS` | false | Enables the native-app bearer sign-in endpoint |
| `REDIS_URL`, `RATE_LIMIT_STORE` | — | Redis for shared rate limits |
| `PRAYER_BREAK_MINUTES` | 20 | |

## External services (to connect in production)

| Need | Where it plugs in |
| --- | --- |
| SMTP (SES, SendGrid, Postmark) | `SMTP_URL`, `EMAIL_FROM` |
| Redis | `REDIS_URL` |
| Place photos (object storage + CDN) | `place_photos.url`; upload endpoint in admin |
| Routing / travel times | `travelMinutes()` in `@riflo/core/geo` |

## Rewards and partners (later, no changes to existing tables)

- `partners (id, name, city_id, status)` and `offers (id, partner_id, place_id?, points_cost, valid_from, valid_to)`.
- `points_ledger (id, user_id, delta, reason, ref_type, ref_id, created_at)`: an append-only ledger. Earn rows should reference only **verified** visits (`visits.source = 'verified'`), since self-reported stamps can be faked.
- `redemptions (id, user_id, offer_id, ledger_id, code, status)`.

## Run and test

```bash
npm run dev:api                        # http://localhost:8080, PGlite in memory, seeded sample content
AUTH_DEV_CODES=true npm run dev:api    # codes returned in the response for local testing
npm test                               # 32 planner + 101 API tests on PGlite
TEST_DATABASE_URL=postgres://… TEST_DATABASE_SSL_CA=ca.crt npm test -w @riflo/api   # same tests on real PostgreSQL
DATABASE_MIGRATION_URL=postgres://riflo_owner… npm run migrate -w @riflo/api
```
