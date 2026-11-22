#!/usr/bin/env bash
# Raflo AI HQ in a real browser: builds the HQ frontend, starts the real HQ API with a scripted AI provider and a
# fake GitHub (test-only entry: apps/hq-api/test/e2e-server.ts), then drives the main workflows with Playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."
npm run build -w @riflo/hq >/dev/null
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT
(cd apps/hq-api && E2E_PORT=8099 E2E_SETUP_CODE=e2e-setup-code HQ_STATIC_DIR=../hq/dist npx tsx test/e2e-server.ts >/tmp/riflo-hq-e2e.log 2>&1) & pids+=($!)
for _ in $(seq 1 60); do curl -sf localhost:8099/hq/v1/health >/dev/null && break; sleep 0.5; done
node tests/e2e/hq.e2e.cjs
