-- Review 2026-11-04, sections 4–7: spreading a trip over all its days.

-- Weekdays a place is closed (0 = Sunday … 6 = Saturday), so the planner can move it to another day.
ALTER TABLE places ADD COLUMN closed_weekdays smallint[] NOT NULL DEFAULT '{}'
  CHECK (closed_weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]);

-- A late arrival shortens the first day and an early departure the last one (minutes from midnight).
ALTER TABLE trips ADD COLUMN first_day_start smallint CHECK (first_day_start BETWEEN 0 AND 1440);
ALTER TABLE trips ADD COLUMN last_day_end smallint CHECK (last_day_end BETWEEN 0 AND 1440);
-- Wanted places that could not be scheduled, with the reason: [{ "placeId": "...", "reason": "..." }].
ALTER TABLE trips ADD COLUMN unscheduled jsonb NOT NULL DEFAULT '[]';

ALTER TABLE trip_stops DROP CONSTRAINT IF EXISTS trip_stops_warning_check;
ALTER TABLE trip_stops ADD CONSTRAINT trip_stops_warning_check CHECK (warning IN ('outside_hours', 'closed_that_day', 'hours_unknown'));
