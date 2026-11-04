#!/usr/bin/env bash
# Nightly backup and a restore test (audit 3.7, acceptance test "restore a backup").
#   ops/db/backup.sh backup   <DATABASE_MIGRATION_URL> <dir>            → <dir>/riflo-YYYYmmdd-HHMM.dump
#   ops/db/backup.sh verify   <dump file> <scratch database URL>        → restores into an EMPTY scratch DB and checks it
# Keep at least 14 daily and 8 weekly dumps in storage in another region; run `verify` weekly.
set -euo pipefail

case "${1:-}" in
  backup)
    url="$2"; dir="$3"; mkdir -p "$dir"
    out="$dir/riflo-$(date -u +%Y%m%d-%H%M).dump"
    pg_dump --format=custom --no-owner --dbname="$url" --file="$out"
    pg_restore --list "$out" >/dev/null   # the archive is readable
    echo "backup written: $out ($(du -h "$out" | cut -f1))"
    ;;
  verify)
    dump="$2"; scratch="$3"
    if [ "$(psql "$scratch" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")" != "0" ]; then
      echo "refusing: the scratch database is not empty" >&2; exit 1
    fi
    pg_restore --no-owner --exit-on-error --dbname="$scratch" "$dump"
    # The restored database must have every migration and plausible data.
    psql "$scratch" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT 'migrations: ' || string_agg(name, ', ' ORDER BY name) FROM schema_migrations;
SELECT 'places: ' || count(*) FROM places;
SELECT 'users: '  || count(*) FROM users;
SELECT 'trips: '  || count(*) FROM trips;
SELECT 'active admins: ' || count(*) FROM users WHERE role = 'admin' AND status = 'active';
DO $$ BEGIN
  IF (SELECT count(*) FROM users WHERE role = 'admin' AND status = 'active') = 0 THEN RAISE EXCEPTION 'restore check failed: no active admin'; END IF;
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '002_security_audit.sql') THEN RAISE EXCEPTION 'restore check failed: migrations missing'; END IF;
END $$;
SQL
    echo "restore verified"
    ;;
  *)
    echo "usage: $0 backup <db-url> <dir> | verify <dump> <scratch-db-url>" >&2; exit 2 ;;
esac
