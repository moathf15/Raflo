# Security audit — RIFLO (November 2026)

Scope: the whole repository (API, user app, admin app, shared packages, database migrations, ops scripts). Method: a full read of the code against the OWASP Top 10 and the checklist below, then a **probe script for every suspected issue**, run against the real API (Fastify `inject`, PGlite). Only issues a probe reproduced are marked **Confirmed**.

"Before" line numbers refer to the uploaded code (commit `6be0985`). "After" refers to the current code.

## Summary

| Severity | Found | Fixed | Open |
| --- | --- | --- | --- |
| Critical | 0 | — | — |
| High | 0 | — | — |
| Medium | 4 (S1–S4) | 4 | 0 (S2 is reduced, not eliminated; see below) |
| Low | 6 (S5–S10) | 3 (S5, S6 partly, S9) | S6 rest, S7, S8, S10 |
| Informational | 6 (I1–I6) | 0 | 6 (documented) |

**Overall:** the security design is sound. Earlier audit rounds left server-side revocable sessions, an HttpOnly cookie with an Origin check, parameterised SQL everywhere, ownership enforced in SQL, a database-enforced last-admin rule and an append-only audit log. The findings below are about abuse resistance and robustness. None exposes data.

---

## Medium

### S1 — Client IP can be spoofed with `X-Forwarded-For` — Confirmed, Fixed
- **Before:** `apps/api/src/app.ts:31`, `trustProxy: cfg.NODE_ENV === 'production'`, which trusts **every** hop.
- **What went wrong:** with `trustProxy: true`, Fastify takes the client IP from the left-most `X-Forwarded-For` entry, and the client writes that entry.
- **How it was exploited:** the probe sent one request per rotated `X-Forwarded-For` value. With the sign-in limit set to 2, it got `202 ×5` (the control without the header got `202,202,429,429,429`).
- **Impact:** bypasses every per-IP rate limit: sign-in (5 per 10 min), place reports, plan generation, events, and the global 300/min. It also fakes the IP stored in `sessions`, `auth_failures` and logs, and it amplifies S2 and S4. The per-email OTP limits in the database still held, so sign-in codes could not be brute-forced.
- **Fix:**
  - A new `TRUST_PROXY` setting (`config.ts:60`, `app.ts:32`). It is `false` by default, or a list of proxy addresses/CIDRs. Only those peers may set the client IP.
  - **Production refuses to start without it** (`config.ts:87`). `true` is refused everywhere, and so are hop counts, because Fastify 5.12 treats a hop count as "trust nothing".
- **Tests:** `security-audit.test.ts › S1`, `audit.test.ts › refuses unsafe production settings`.
- **Deploy impact:** set `TRUST_PROXY` to the load balancer's range (see `docs/LAUNCH.md` §3).

### S2 — A stranger can lock the owner out of sign-in — Confirmed, Mitigated
- **Before:** `apps/api/src/modules/auth.ts:19-24` (lockout counted by email only) and `:94` (a guess with no code issued still counted as a failure).
- **How it was exploited:** 10 wrong guesses for someone else's email gave the owner `429 too_many_attempts` for 900 s. With 30 guesses the lock lasted 24 h. No code needed to exist, and with S1 the per-IP limit didn't apply.
- **Impact:** denial of service against any account, including staff accounts, whose addresses are often guessable.
- **Fix** (`auth.ts:25-45`, `:115`):
  1. A guess when no live code exists is refused (400) but **not recorded**. Each counted failure now costs the attacker a code request, which is limited to 5 per hour per email and **emails the owner**.
  2. The short tier (10 failures → 15 min) is now per **email + IP**, so it doesn't block the owner on another network.
  3. The 20 → 1 h and 30 → 24 h tiers stay per email. The total number of guesses an attacker gets on one account stays at about 30 per day, so brute-force resistance is unchanged.
- **Residual risk (accepted):** someone who requests codes for a victim and burns them can still reach the 1 h tier after 4 code requests. The victim will see the code emails. Closing this fully would need a second factor such as a CAPTCHA or device binding, which is a product decision.
- **Tests:** `security-audit.test.ts › S2`, `hardening.test.ts › progressive lockout` (updated to the new tiers).

### S3 — A dead session cookie broke guest features and couldn't be signed out — Confirmed, Fixed
- **Before:** `apps/api/src/auth/session.ts:81-100` threw 401 for any invalid token, even on routes guests may use. `modules/auth.ts:136-141` (logout) threw before clearing the cookie.
- **How it showed up:** after "sign out everywhere", a suspension or a `JWT_SECRET` rotation, the browser kept the cookie. `POST /v1/plans` then returned 401 instead of 200, and `/v1/auth/logout` returned 401 without clearing the cookie.
- **Impact:** availability. Affected browsers couldn't plan, report or send events until they signed in again.
- **Fix:**
  - A cookie that is no longer valid makes the request a **guest** request and is marked stale (`session.ts:68`, `:106`).
  - An `onSend` hook clears the cookie on the response (`app.ts:46`), so logout always succeeds.
  - Account routes still return 401.
  - Bearer tokens (native apps) still return 401, because the client sent them on purpose.
  - The CSRF Origin check for valid cookies is unchanged.
- **Tests:** `security-audit.test.ts › S3` (4 cases, including CSRF still enforced).

### S4 — `GET /v1/trips` ran about 6 queries per trip — Confirmed, Fixed
- **Before:** `apps/api/src/modules/trips.ts:117-121` and `loadTrip` at `:47-56`. Each trip also reloaded its city's places and recomputed the planner.
- **Measured:** 10 trips cost 62 queries. The 200-trip quota means roughly 1,200 queries per request, which an attacker could repeat at the global rate limit (unbounded with S1).
- **Fix:** `loadTrips` (`trips.ts:65`) loads all trips with **one query per table** (`= ANY($1::uuid[])`). `cityLoader` (`:31`) loads each city's places once per request. `GET /v1/trips/:id` uses the same path.
- **Test:** `security-audit.test.ts › S4` asserts that 1 trip and 10 trips use the same number of queries.

## Low

### S5 — A malformed `Referer` returned 500 — Confirmed, Fixed
`auth/session.ts:49` before: `new URL(referer)` threw, and the error handler answered 500 and logged an error. The parse is now guarded (`session.ts:48`), and the result is `403 csrf_origin`. Test: `security-audit.test.ts › S5`.

### S6 — Vulnerable dependencies (development tooling) — Confirmed, Partly fixed
- **Before:** vite 5.4.10 (1 High, many Moderate) and tsx 4.19.2 / esbuild 0.23 (Moderate).
- **Fixed:** vite is now 5.4.21 and tsx 4.23.15. This closes the tsx/esbuild advisory and 9 vite advisories (several `server.fs.deny` bypasses and a cross-origin dev-server read).
- **Still open:** `npm audit` reports 4 packages (1 High, 3 Moderate). They are vite ≤ 6.4.3 dev-server and Windows editor-launch issues, plus the esbuild 0.21 dev-server issue inside vite 5. **None of them reaches production bundles or the API at run time.** Fixing them needs vite ≥ 6.4.4 (a major upgrade, with matching `@vitejs/plugin-react` and `vite-plugin-singlefile` upgrades), planned as its own change.
- **Until then:** run `vite` dev servers only on trusted networks (the default host is localhost).

### S7 — Production runs TypeScript through `tsx`, a dev tool — Open
`apps/api/package.json` runs `"start": "tsx src/server.ts"`. Since this audit, tsx is in `devDependencies`, so `npm ci --omit=dev` breaks `start`, and a transpiler runs in production. Recommendation: compile the API (`tsc` with emit, or esbuild) into `dist/` and run `node dist/server.js`. Not changed here because it changes the deploy procedure.

### S8 — Safety checks only apply when `NODE_ENV=production` — Open (potential)
`config.ts` defaults `NODE_ENV` to `development`, and the production checks (`config.ts:80`) only run when it is exactly `production`. A server started without it uses the dev JWT secret, an in-memory database and the seeded `admin@riflo.local`. With `AUTH_DEV_CODES=true`, anyone who can reach that server can sign in as that admin. Recommendation: refuse to start with `AUTH_DEV_CODES=true` unless `NODE_ENV=development` is explicit, or listen only on localhost in that mode.

### S9 — Two concurrent saves of one trip could 500 — Potential, Fixed
`modules/trips.ts:185-197` before: two transactions could each delete and re-insert `trip_days`, causing a unique-key error and a 500. This **couldn't be reproduced on PGlite**, which runs queries one at a time. The fix takes `SELECT … FOR UPDATE` on the trip row first (`trips.ts:220`), so saves of the same trip queue. Test: `security-audit.test.ts › S9` (functional; a true race needs `TEST_DATABASE_URL`).

### S10 — Account deletion without a fresh sign-in — Open (design)
`DELETE /v1/me` (`auth.ts:194`) deletes everything on one request. CSRF is blocked, but a stolen session can destroy the account. Recommendation: require a fresh code (step-up) before deletion. Not changed here because it changes the API contract and the UI.

## Informational
| # | Note | Where |
| --- | --- | --- |
| I1 | Sign-in codes are hashed as `sha256(JWT_SECRET:code)`. Prefer an HMAC with a key derived for this purpose, not the token-signing key. | `auth/session.ts` (`hash`) |
| I2 | Sessions last 30 days with no idle timeout, and users cannot list or revoke single sessions. | `config.ts` `SESSION_TTL_DAYS` |
| I3 | `roles.sql` ships placeholder passwords, and narrowing the app role on `audit_log` is a commented-out manual step (the trigger still blocks edits). | `ops/db/roles.sql` |
| I4 | 4xx errors from Fastify itself (e.g. invalid JSON) repeat Fastify's message text. | `lib/http.ts` |
| I5 | `%` and `_` are not escaped in the admin user search. It is parameterised, so there's no injection. | `modules/admin.ts` (`/v1/admin/users`) |
| I6 | CSP is a meta tag. Preview builds (`SINGLE_FILE=1`) have none. `frame-ancestors` and HSTS must come from the static host's headers (documented in LAUNCH.md). | `packages/ui/csp.ts` |

## Checked and sound
| Area | Evidence |
| --- | --- |
| SQL injection | All queries are parameterised. Dynamic SQL uses only constant fragments (`PLACE_COLUMNS`, quota SQL). The probe with `x' OR 1=1--` got 404. |
| XSS | No `dangerouslySetInnerHTML`, `innerHTML` or `eval` in either app. React escapes all text. The email HTML only inserts the 6 digits. |
| CSRF | SameSite=Lax cookie plus an allow-listed Origin/Referer on writes. The probe got 403 for both no Origin and a foreign Origin. |
| IDOR | Every user resource query includes `user_id = $n`. `reusedFrom` and `tripId` on visits are ownership-checked. Unknown ids return 404. |
| RBAC | `staff` (editor, admin) vs `admin` only for user management. Admins cannot change their own role or status. The last active admin is protected by a trigger with an advisory lock. |
| Sessions | Server-side rows, revocable, bound to their transport (cookie vs bearer). Suspension revokes all sessions. The role is re-read from the database on every request. |
| OTP | 6 digits, 10-minute expiry, 5 attempts reserved atomically, single use, older codes invalidated, 60 s resend cooldown, 5 codes per hour. |
| CORS / headers | Explicit origin allowlist (https enforced in production), helmet, body limit 64 KB (2 KB for events), request timeouts. |
| Data at rest / in transit | Database TLS with certificate verification. Only code hashes are stored. Logs hash email addresses and never contain codes. |
| SSRF, RCE, path traversal, file upload | No such surfaces: the API makes no outbound requests to user-supplied URLs, executes nothing, and has no uploads. Migrations are read from a fixed directory. |
| Secrets | No real secrets in the repository. The dev JWT secret is refused in production. |

## Technical findings vs legal compliance
The items above are technical. Separately, for the **PDPL** (a legal matter for counsel, not a code defect):
- after `DELETE /v1/me`, the email address remains in `login_codes` (up to 1 day) and `auth_failures` (up to 7 days) until the hourly cleanup;
- report texts written by the user are kept (anonymised);
- IP addresses are stored with sessions and failures.

The privacy policy should state these retention periods.

## Verification
- `npm test`: 32 planner + 101 API tests pass (11 of the API tests are new).
- The new tests were run against the uploaded code: S1 (listed proxy), S2, S3, S4 and S5 fail there and pass now.
- `npm run typecheck` is clean, and both app builds succeed.
- `tests/e2e/run.sh` passes all three browser suites (API + web + admin in Chromium).
- **Not verified here:** behaviour on a real PostgreSQL server (set `TEST_DATABASE_URL`), Redis-backed rate limits, SMTP delivery, and the production proxy layout.
