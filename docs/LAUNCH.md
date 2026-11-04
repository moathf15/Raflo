# Launch checklist (MVP, Madinah)

Everything in the repository works end to end today (`tests/e2e/run.sh`). What remains needs accounts or decisions on your side.

## 1. External services to set up

| # | Service | Why | Suggested options | Where it plugs in |
| --- | --- | --- | --- | --- |
| 1 | Email sending (SMTP) | Sign-in codes | Amazon SES (Bahrain region), SendGrid, Postmark | `EMAIL_PROVIDER=smtp`, `SMTP_URL`, `EMAIL_FROM` |
| 2 | Redis | Rate limits shared across API instances | Any managed Redis | `REDIS_URL` |
| 3 | Image storage + CDN | Place photos from the admin | Any S3-compatible storage with a CDN | `place_photos` table; add an upload endpoint in admin |
| 4 | Managed PostgreSQL with TLS | Production database | A Saudi-region provider for data residency (e.g. STC Cloud, Oracle Jeddah, Google Dammam) | `DATABASE_URL`, `DATABASE_SSL_CA`; roles from `ops/db/roles.sql` |
| 5 | Hosting | API + two static apps | Node host for the API; any static host/CDN for `apps/web/dist` and `apps/admin/dist` | see §3 |
| 6 | Domain + HTTPS | e.g. `riflo.sa`, `admin.riflo.sa`, `api.riflo.sa` | — | `CORS_ORIGINS`, `VITE_API_URL` |
| 7 | (Later) SMS | Phone sign-in, preferred by many Saudi users | Unifonic, Taqnyat | Same two auth endpoints |
| 8 | (Later) Maps / routing | Real map tiles and travel times | Mapbox, Google Maps | `DayMap`, `travelMinutes()` |

## 2. Content before launch

- Review every Madinah place in the admin: opening hours, cost, etiquette, accurate coordinates, at least one photo.
- The sample coordinates and times in `packages/core/src/data/sample.ts` are approximate and must not reach production unreviewed. In production, load content through the admin, not `npm run seed`.

## 3. Deploy

```bash
# Database (once): create roles, then migrate as the owner and grant the app role
psql "$ADMIN_URL" -f ops/db/roles.sql
DATABASE_MIGRATION_URL=postgres://riflo_owner:…@db/riflo DATABASE_SSL_CA=ca.crt npm run migrate -w @riflo/api
psql "$ADMIN_URL" -c "…post-migration grants from the end of ops/db/roles.sql…"
npm run create-admin -w @riflo/api -- you@company.sa    # first admin account

# API (connects as riflo_app; migrations do not run on start)
NODE_ENV=production DATABASE_URL=postgres://riflo_app:…@db/riflo DATABASE_SSL_CA=ca.crt \
  JWT_SECRET=<64 random chars> CORS_ORIGINS=https://riflo.sa,https://admin.riflo.sa COOKIE_DOMAIN=.riflo.sa \
  EMAIL_PROVIDER=smtp SMTP_URL=smtps://… EMAIL_FROM="RIFLO <no-reply@riflo.sa>" REDIS_URL=rediss://… \
  npm run start -w @riflo/api

# Apps (static files)
VITE_API_URL=https://api.riflo.sa npm run build -w @riflo/web     # → apps/web/dist
VITE_API_URL=https://api.riflo.sa npm run build -w @riflo/admin   # → apps/admin/dist
```

- Production refuses to start with a weak or default `JWT_SECRET`, `AUTH_DEV_CODES` on, no SMTP, non-HTTPS CORS origins, no `DATABASE_URL`, or no Redis.
- A production build without `VITE_API_URL` shows a configuration error instead of silently using sample data (`VITE_ALLOW_MOCK=true` is only for demos).
- The built apps carry a Content-Security-Policy meta tag. Also send it, plus `frame-ancestors 'none'` and HSTS, as **HTTP headers** from the static host (meta tags cannot set `frame-ancestors`).
- The API and apps should share a site (e.g. `riflo.sa`, `api.riflo.sa`) so the SameSite=Lax cookie is sent.

## 3a. Backups

```bash
ops/db/backup.sh backup  "$DATABASE_MIGRATION_URL" /backups          # nightly, pg_dump custom format
ops/db/backup.sh verify  /backups/riflo-….dump "$SCRATCH_DB_URL"     # monthly: restore into an empty DB and check it
```

## 4. Legal and policy

- Privacy policy and terms in Arabic, aligned with the PDPL (account deletion already exists: `DELETE /v1/me`).
- Content rights for every photo (the `place_photos.credit` column records attribution).

## 5. After launch: what to watch

The admin overview shows these from real data:

- **Plan completion**: planning sessions that reached a ready plan ÷ sessions started. A drop at one step means that step needs work.
- **Return rate**: users who created another trip within 90 days of their first. This is the success measure from the brief.
- **Reports and stale content**: the "needs your decision" list.

## 6. Before opening to the public

- An external penetration test against the deployed stack.
- Error monitoring and uptime alerts on the API (5xx rate, sign-in failures, lockouts).
- Pagination on admin lists once content passes a few hundred places or users.
