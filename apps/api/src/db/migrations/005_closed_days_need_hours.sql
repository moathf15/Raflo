-- Closing weekdays are part of the opening hours: the planner reads them only with open/close minutes.
-- Refuse closing days on a place with no hours, instead of storing data that would be silently ignored.
UPDATE places SET closed_weekdays = '{}' WHERE open_minute IS NULL;
ALTER TABLE places ADD CONSTRAINT places_closed_needs_hours CHECK (cardinality(closed_weekdays) = 0 OR open_minute IS NOT NULL);
