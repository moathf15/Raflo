# Changelog

All notable changes. Earlier reviews are recorded in `docs/SECURITY_AUDIT_FIXES.md`, `docs/REVIEW_2_FIXES.md`, `docs/MANUAL_EDIT_FIX.md` and `docs/SELECTION_FIX.md`.

## 2026-11-04 — Security, quality and documentation audit

Details and evidence for every finding: [docs/SECURITY_AUDIT.md](docs/SECURITY_AUDIT.md).

### Security

| File | What changed | Why | Benefit | Impact |
| --- | --- | --- | --- | --- |
| `apps/api/src/config.ts`, `apps/api/src/app.ts` | New `TRUST_PROXY` setting; Fastify trusts `X-Forwarded-For` only from the listed proxies. Required in production; `true` and hop counts refused | S1: any client could choose its IP and bypass every per-IP limit | Rate limits and stored IPs are trustworthy | **Deploy: set `TRUST_PROXY`** (see LAUNCH.md §3), or the API refuses to start |
| `apps/api/src/modules/auth.ts` | Guesses when no live code exists are refused but not counted. The 10-failure / 15-min lockout is per email+IP; the 20 → 1 h and 30 → 24 h tiers stay per email | S2: anyone could lock any account out with 10 requests | Lockout costs the attacker code emails and no longer blocks the owner on another network; brute-force ceiling unchanged (~30 guesses/day) | **Business rule changed** (option "a" of the audit plan, the recommended default). Existing failure rows keep counting |
| `apps/api/src/auth/session.ts`, `apps/api/src/app.ts` | A cookie whose session is invalid makes the request a guest one, and the cookie is cleared on the response. Bearer tokens still get 401 | S3: revoked or stale cookies broke planning and couldn't be signed out | Users recover automatically after "sign out everywhere", suspension or key rotation | Guest routes no longer answer 401 for a dead cookie; logout always answers 204 |
| `apps/api/src/auth/session.ts` | Malformed `Referer` handled | S5: was a 500 | Clean 403 `csrf_origin` | None |
| `apps/api/src/modules/trips.ts` | `PUT /v1/trips/:id` locks the trip row (`FOR UPDATE`) before rewriting days | S9: concurrent saves could hit a unique-key error | Saves of one trip queue instead of failing | Concurrent saves of the same trip wait for each other |
| `package.json`, `apps/api/package.json`, `package-lock.json` | vite 5.4.10 → 5.4.21, tsx 4.19.2 → 4.23.15 | S6: dev-tool advisories | Closes 10 advisories without a major upgrade | Dev tooling only; builds verified |

### Performance and quality

| File | What changed | Why | Benefit | Impact |
| --- | --- | --- | --- | --- |
| `apps/api/src/modules/trips.ts` | `loadTrips` loads all of a user's trips with one query per table and each city's places once | S4: ~6 queries per trip (62 for 10 trips) | Constant number of queries; less DB load | Response shape unchanged |
| `apps/api/src/lib/users.ts` (new), `modules/auth.ts`, `modules/passport.ts`, `modules/trips.ts` | `profileOf`, `wishListOf`, `rememberPreferences` replace repeated queries | Duplication (wish list ×5, preferences ×2, profile ×2) | One place to change each query | The wish list passed to the planner is now ordered by date added (was unordered) |
| `apps/api/src/db/client.ts`, `src/server.ts`, `src/db/cli.ts` | `openDb()` builds the database for both entry points | Pool and TLS setup was written twice | One place for connection settings | None |

### Tests

| File | What changed |
| --- | --- |
| `apps/api/test/security-audit.test.ts` (new) | 10 regression tests for S1–S5 and S9; S1 (listed proxy), S2, S3, S4 and S5 fail on the code before this change |
| `apps/api/test/hardening.test.ts` | Lockout test rewritten for the per-IP and per-email tiers |
| `apps/api/test/audit.test.ts` | Production config test covers `TRUST_PROXY` (missing, `true`, hop count refused) |

### Documentation

| File | What changed |
| --- | --- |
| `docs/SECURITY_AUDIT.md`, `docs/CODE_QUALITY_REPORT.md`, `docs/PROJECT_STRUCTURE.md`, `docs/DEVELOPER_GUIDE.md`, `CHANGELOG.md` | New |
| `docs/LAUNCH.md` | `TRUST_PROXY` in the deploy command and the refusal list |
| `docs/ARCHITECTURE.md` | Removed the outdated "tokens live in localStorage"; prayer times come from `prayer.ts` |
| `docs/BACKEND.md`, `README.md` | New lockout rule, test counts, links to the new documents |
| `docs/SECURITY_AUDIT_FIXES.md` | A note that the lockout rule of item 3.2 was revised |

### Not changed (decisions pending)
These are documented in SECURITY_AUDIT.md and CODE_QUALITY_REPORT.md:
- vite major upgrade (S6 remainder);
- compiling the API for production (S7);
- `AUTH_DEV_CODES` outside explicit development (S8);
- a fresh code before account deletion (S10);
- HMAC for code hashes (I1);
- no schema changes.
