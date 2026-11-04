-- Fixes from the Security & Logic Audit (3 Nov 2026).

-- 3.1 / 3.2  OTP: invalidate older codes, record every failure for per-email lockout.
ALTER TABLE login_codes ADD COLUMN invalidated_at timestamptz;
CREATE TABLE auth_failures (
  id          bigserial PRIMARY KEY,
  identifier  text NOT NULL,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_failures_identifier_idx ON auth_failures (identifier, created_at DESC);

-- P0  Server-side sessions so a token can be revoked (sign-out, suspension, "sign out everywhere").
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  user_agent    text,
  ip            text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- 5.2  Prayer times are computed per city and date, in the city's time zone.
ALTER TABLE cities ADD COLUMN timezone text NOT NULL DEFAULT 'Asia/Riyadh';

-- 5.1 / 5.5  Structured opening hours (checked at arrival time), source and last verification.
ALTER TABLE places ADD COLUMN open_minute int CHECK (open_minute BETWEEN 0 AND 1439);
ALTER TABLE places ADD COLUMN close_minute int CHECK (close_minute BETWEEN 1 AND 1440);
ALTER TABLE places ADD CONSTRAINT places_hours_order CHECK (open_minute IS NULL OR close_minute IS NULL OR open_minute < close_minute);
ALTER TABLE places ADD CONSTRAINT places_hours_pair CHECK ((open_minute IS NULL) = (close_minute IS NULL));
ALTER TABLE places ADD COLUMN source text;
ALTER TABLE places ADD COLUMN verified_at date;
UPDATE places SET open_minute = 0, close_minute = 1440 WHERE opening_hours = 'مفتوح طوال اليوم';

-- 5.1  Stops remember when they fall outside opening hours (or hours are unknown).
ALTER TABLE trip_stops ADD COLUMN warning text CHECK (warning IN ('outside_hours', 'hours_unknown'));

-- 3.4  Visits are self-reported records, said so explicitly.
ALTER TABLE visits ADD COLUMN source text NOT NULL DEFAULT 'self_reported' CHECK (source IN ('self_reported', 'verified'));
ALTER TABLE visits ADD COLUMN updated_at timestamptz;

-- 5.5  Report lifecycle handled one by one, with a reason.
ALTER TABLE reports DROP CONSTRAINT reports_status_check;
UPDATE reports SET status = 'new' WHERE status = 'open';
UPDATE reports SET status = 'rejected' WHERE status = 'dismissed';
ALTER TABLE reports ALTER COLUMN status SET DEFAULT 'new';
ALTER TABLE reports ADD CONSTRAINT reports_status_check CHECK (status IN ('new', 'in_review', 'resolved', 'rejected', 'reopened'));
ALTER TABLE reports ADD COLUMN resolution_note text;
ALTER TABLE reports ADD COLUMN updated_at timestamptz;
DROP INDEX reports_open_idx;
CREATE INDEX reports_status_idx ON reports (status, place_id);

-- 3.5 / 5.7  Events carry a planning-session id so funnel steps belong to the same attempt.
ALTER TABLE events ADD COLUMN session_id text;
CREATE INDEX events_session_idx ON events (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX events_anon_time_idx ON events (anonymous_id, created_at) WHERE anonymous_id IS NOT NULL;
CREATE INDEX events_user_time_idx ON events (user_id, created_at) WHERE user_id IS NOT NULL;

-- 3.7  Protected audit log: rows can't be edited or deleted. The only change allowed is the
--      database itself clearing actor_id when an account is erased (PDPL).
CREATE FUNCTION audit_log_protect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.actor_id IS NULL AND OLD.actor_id IS NOT NULL
     AND NEW.action = OLD.action AND NEW.entity = OLD.entity AND NEW.entity_id = OLD.entity_id
     AND NEW.changes = OLD.changes AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_protect BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_protect();
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL;

-- 4  There must always be at least one active admin, whatever path changes users.
CREATE FUNCTION keep_one_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.status <> 'active')
     AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND role = 'admin' AND status = 'active') THEN
    RAISE EXCEPTION 'last_admin' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER keep_one_admin BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION keep_one_admin();
