# Deploying HQ

HQ is one Node service that serves the API, the background worker and the built frontend.

```bash
npm ci
npm run build -w @riflo/hq
HQ_STATIC_DIR=$PWD/apps/hq/dist npm start -w @riflo/hq-api   # npm -w runs in apps/hq-api, so use an absolute path
```

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV=production` | yes | Enables production checks |
| `HQ_DATABASE_URL` | recommended | PostgreSQL URL. Without it, PGlite stores data in `HQ_PGLITE_DIR` (single instance only) |
| `HQ_ENCRYPTION_KEY` | yes | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts provider keys and the GitHub token. Keep it backed up: losing it means re-entering credentials |
| `HQ_PUBLIC_URL` | yes | `https://…` origin users open; used for CSRF and the OAuth callback |
| `HQ_ALLOWED_ORIGINS` | no | Extra allowed origins |
| `HQ_PORT` | no | Default 8090 |
| `HQ_STATIC_DIR` | yes for the UI | Absolute path to `apps/hq/dist` (or relative to `apps/hq-api`) |
| `HQ_WORKER` | no | `false` on API-only instances when workers run separately |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | no | Enables "Connect with GitHub" |
| `DATABASE_SSL`, `DATABASE_SSL_CA` | no | TLS to PostgreSQL |

Migrations run on start (`MIGRATE_ON_START`, default true) or with `npm run migrate -w @riflo/hq-api`.

## GitHub App (recommended over an OAuth app)
Create a GitHub App, install it on `moathf15/Raflo` only, set the callback URL to
`$HQ_PUBLIC_URL/hq/v1/github/oauth/callback`, enable "Request user authorization (OAuth) during installation", and
give it: Contents read (read & write only if you enable branch creation), Issues read & write, Pull requests read
& write, Checks read, Metadata read. Put its client id/secret in the variables above.

## Backups
Back up the PostgreSQL database (or the PGlite directory) and `HQ_ENCRYPTION_KEY`. `ops/db/backup.sh` in this
repository can be adapted for the HQ database.

## Running next to Raflo
HQ shares nothing at runtime with the Raflo API; it can use the same PostgreSQL server with its own database or
schema. It is not deployed by the GitHub Pages workflow.
