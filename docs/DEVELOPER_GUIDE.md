# Developer guide

## 1. Understand the project in five minutes

RIFLO plans trips in Saudi cities, starting with Madinah.
- **Travellers** choose dates and interests. The **planner** builds a day-by-day plan that respects opening hours and prayer times. Travellers edit and save trips and collect visit "stamps" in a **Passport**.
- **Staff** manage places and reader reports in the **admin** app.

Read in this order:
1. `README.md`
2. [`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md): what each folder does
3. [`ARCHITECTURE.md`](ARCHITECTURE.md): frontend rules
4. [`BACKEND.md`](BACKEND.md): tables and endpoints
5. `packages/core/src/api/contract.ts`: everything the apps can ask for

Three rules hold the design together:
1. **Screens never touch data directly.** They call `UserApi` / `AdminApi`. The HTTP and mock implementations are interchangeable.
2. **The server is the authority.** The client sends place order; the server computes the schedule, validates edits and owns a trip's selection. The shared planner in `@riflo/core` only gives the client instant feedback.
3. **Every rule is enforced in the API,** whatever the UI shows. `AdminGate` is convenience; `sessions.role()` is the control.

## 2. Run it

Requires Node 18+ (this audit ran on Node 22).

```bash
npm install
AUTH_DEV_CODES=true npm run dev:api                    # API on :8080, in-memory PostgreSQL (PGlite) + sample content
VITE_API_URL=http://localhost:8080 npm run dev:web     # user app on :5173
VITE_API_URL=http://localhost:8080 npm run dev:admin   # admin on :5174 — sign in as admin@riflo.local
```

- `AUTH_DEV_CODES=true` shows the sign-in code on screen instead of emailing it. It is refused in production; **never expose such a server to a network.**
- Without `VITE_API_URL`, the apps run on the in-browser mock (development only).
- To keep local data between restarts, set `PGLITE_DIR=./.data` (ignored by git).

### Checks

```bash
npm test             # planner + API tests (PGlite). TEST_DATABASE_URL=postgres://… runs them on real PostgreSQL
npm run typecheck    # all three apps
npm run build        # both apps
tests/e2e/run.sh     # builds, starts everything, drives Chromium (needs Playwright; see the script header)
npm audit            # remaining advisories are dev-server only; see SECURITY_AUDIT.md S6
```

## 3. Configure the environment

Every variable is declared, typed and documented in `apps/api/src/config.ts`. The ones you will meet:

| Variable | Dev default | Production |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` (turns on the refusal rules below) |
| `DATABASE_URL` | unset → PGlite | required; the limited `riflo_app` role |
| `DATABASE_MIGRATION_URL` | — | owner role, used only by `npm run migrate` / `create-admin` |
| `DATABASE_SSL_CA` | — | CA file of the database certificate (TLS is forced on) |
| `JWT_SECRET` | dev placeholder | required, 48+ random characters |
| `CORS_ORIGINS` | localhost ports | required, all `https://` |
| `COOKIE_DOMAIN` | — | e.g. `.riflo.sa` so the apps and API share the cookie |
| `EMAIL_PROVIDER`, `SMTP_URL`, `EMAIL_FROM` | `log` | `smtp` plus both values |
| `REDIS_URL` / `RATE_LIMIT_STORE` | memory | Redis, or `memory` only with exactly one instance |
| `TRUST_PROXY` | `false` | **required**: the load balancer's IPs/CIDRs (or `false` if none). Never `true` |
| `AUTH_DEV_CODES` | `false` | must be `false` |
| `NATIVE_CLIENTS` | `false` | `true` only when native apps ship (enables bearer sign-in) |

Production refuses to start when any rule is broken; the error lists every problem. Full deployment steps are in [`LAUNCH.md`](LAUNCH.md).

## 4. Navigate the code

| I want to… | Start at |
| --- | --- |
| change how plans are built | `packages/core/src/planner.ts` (`generatePlan`, `layoutDay`, `validateDays`) and `packages/core/test/planner.test.ts` |
| change an endpoint | `apps/api/src/modules/<area>.ts`; request schemas in `lib/schemas.ts`; row → JSON in `lib/mappers.ts` |
| change sign-in, sessions or CSRF | `apps/api/src/auth/session.ts`, `apps/api/src/modules/auth.ts` |
| change limits or quotas | `QUOTAS` in `context.ts`; per-route `config.rateLimit`; OTP limits at the top of `modules/auth.ts` |
| change a screen | `apps/<web|admin>/src/features/<area>/`; copy in `src/i18n/ar.ts`; shared components in `packages/ui` |
| change the look | `packages/ui/src/styles/tokens.css` (tokens), `components.css` |

## 5. Add a feature: the usual path

1. **Types and contract.** Add the type to `packages/core/src/types.ts` and the method to `UserApi`/`AdminApi` in `contract.ts`.
2. **Database (if needed).** Add `apps/api/src/db/migrations/00N_<name>.sql`. Never edit an applied migration. Keep it runnable on both PGlite and PostgreSQL 15+.
3. **API.** Add the route in the right module:
   - start with the guard (`sessions.required`, `sessions.role(req, 'editor', 'admin')`, or `sessions.optional` for guest routes);
   - parse input with zod;
   - scope every user-owned query with `AND user_id = $n`, and answer 404 (not 403) for other users' ids;
   - wrap multi-statement writes in `db.tx`;
   - wrap admin changes in a transaction with `audit(t, …)`;
   - use `withQuota` for count-then-insert limits.
4. **Implementations.** Implement the method in `api/http.ts` and `api/mock.ts`.
5. **Screen.** Add a feature folder; handle `useAsync`'s loading, error and ready states.
6. **Tests.** Add an API test next to the closest existing file, a planner test for planner logic, and an e2e step if it's a main user path. Run `npm test && npm run typecheck`.
7. **Record it.** Add an entry to `CHANGELOG.md`; update `BACKEND.md` for new endpoints or tables.

## 6. Work with the API and database

- **Errors:** always `{ "error": { "code": "snake_case", "message": "…" } }`. Throw `new HttpError(status, code)`. Zod errors become 400 `invalid_request`; known PostgreSQL client errors become 400 or 409; anything else becomes a logged 500 `internal` with no details.
- **Auth from a client:**
  - browsers rely on the cookie (`credentials: 'include'`) and must send an `Origin` from `CORS_ORIGINS` on writes;
  - native apps use `/v1/auth/native/verify` and `Authorization: Bearer`;
  - a dead cookie makes the request a guest one and is cleared.
- **SQL:** parameters only (`$1…`), never string-built values. Column lists for places live in `PLACE_COLUMNS`.
- **Dates:** `date` columns come back as `'yyyy-mm-dd'` strings on purpose (see `db/client.ts`). Don't convert them to `Date`.
- **Local SQL console:** `PGLITE_DIR=./.data npm run seed -w @riflo/api`, then inspect with any PGlite tool, or point `DATABASE_URL` at a local PostgreSQL.

## 7. Security checklist for every change

- [ ] New route has an explicit guard, and guest access is deliberate.
- [ ] User-owned rows are filtered by `user_id` in SQL.
- [ ] Input is validated with zod (types, sizes, enums); params like ids are validated too.
- [ ] Writes that count-then-insert use `withQuota`; multi-row rewrites lock what they rewrite.
- [ ] No secrets, codes or raw emails in logs (use `maskEmail`).
- [ ] No `dangerouslySetInnerHTML`; URLs from data are checked before use as `href`/`src`.
- [ ] Production refusal rules in `config.ts` updated for any new security-relevant setting.
- [ ] A test proves the rule (both the allowed and the refused case).
