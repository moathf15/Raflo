-- Review 2026-11-04, section 3.

-- Bearer tokens are only for native clients, from their own sign-in endpoint.
-- Each session remembers how it was issued, and is accepted only that way:
-- a cookie session cannot be replayed as a bearer token, and the reverse.
ALTER TABLE sessions ADD COLUMN transport text NOT NULL DEFAULT 'cookie' CHECK (transport IN ('cookie', 'bearer'));

-- The last-admin rule under concurrency. Two transactions demoting two different admins
-- each saw the other admin still active (NOT EXISTS) and both committed, leaving none.
-- Every change that removes an active admin now takes one transaction-scoped advisory lock first,
-- so these changes run one after another and the second sees the first's result.
-- (In READ COMMITTED each statement in a volatile plpgsql function takes a fresh snapshot,
-- so the check below runs after the lock is held and sees committed changes.)
CREATE OR REPLACE FUNCTION keep_one_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'admin' AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'admin' OR NEW.status <> 'active') THEN
    PERFORM pg_advisory_xact_lock(hashtext('riflo:admin-roles'));
    IF NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND role = 'admin' AND status = 'active') THEN
      RAISE EXCEPTION 'last_admin' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
