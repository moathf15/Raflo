-- Least-privilege database roles for RIFLO (audit 3.7 and 4).
-- Run once as a superuser on the production database, then:
--   DATABASE_MIGRATION_URL → riflo_owner  (used only by `npm run migrate` / `create-admin`)
--   DATABASE_URL           → riflo_app    (used by the running API)
-- Replace the passwords, and require TLS for both roles in pg_hba.conf (hostssl only).

CREATE ROLE riflo_owner LOGIN PASSWORD 'change-me-owner' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE riflo_app   LOGIN PASSWORD 'change-me-app'   NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 40;

-- The owner role owns the schema and runs migrations.
ALTER DATABASE riflo OWNER TO riflo_owner;
ALTER SCHEMA public OWNER TO riflo_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- The app can read and write data, but can't change the schema.
GRANT USAGE ON SCHEMA public TO riflo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE riflo_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO riflo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE riflo_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO riflo_app;

-- Server-side limits for the app role (audit 3.6): no query or idle transaction can run away.
ALTER ROLE riflo_app SET statement_timeout = '5s';
ALTER ROLE riflo_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE riflo_app SET lock_timeout = '3s';

-- After the first `npm run migrate` (as riflo_owner), apply the grants to the existing tables
-- and narrow the audit log to append-only for the app (the trigger also blocks edits):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO riflo_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO riflo_app;
--   REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM riflo_app;
--   REVOKE ALL ON schema_migrations FROM riflo_app;
--   GRANT SELECT ON schema_migrations TO riflo_app;
