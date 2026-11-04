#!/usr/bin/env bash
# Full-system test: API (in-memory Postgres) + user app + admin, driven in a real browser.
# Needs Playwright once: npm i -D playwright && npx playwright install chromium
set -euo pipefail
cd "$(dirname "$0")/../.."

export VITE_API_URL=http://localhost:8080
npm run build -w @riflo/web >/dev/null
npm run build -w @riflo/admin >/dev/null

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

(cd apps/api && PORT=8080 AUTH_DEV_CODES=true AUTH_RATE_LIMIT=1000 CORS_ORIGINS=http://localhost:4173,http://localhost:4174 npx tsx src/server.ts >/tmp/riflo-api.log 2>&1) & pids+=($!)
(cd apps/web && npx vite preview --port 4173 --strictPort >/dev/null 2>&1) & pids+=($!)
(cd apps/admin && npx vite preview --port 4174 --strictPort >/dev/null 2>&1) & pids+=($!)

for _ in $(seq 1 40); do
  curl -sf localhost:8080/health >/dev/null && curl -sf localhost:4173 >/dev/null && curl -sf localhost:4174 >/dev/null && break
  sleep 1
done

node tests/e2e/system.e2e.cjs
node tests/e2e/manual-edit.e2e.cjs
node tests/e2e/selection.e2e.cjs
