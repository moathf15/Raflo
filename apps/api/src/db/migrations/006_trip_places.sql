-- Source-of-truth ticket (2026-11-04): every place chosen for a trip, kept by the server.
-- Changed only by server operations on an explicit choice: scheduling a place in a day, choosing it, or removing it.
-- The "could not fit" list is computed from this table and the actual days on every read.
CREATE TABLE trip_places (
  trip_id   uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  place_id  text NOT NULL REFERENCES places(id),
  -- why it is part of the trip: an interest or the wish list when the trip was created, or a manual choice
  origin    text NOT NULL CHECK (origin IN ('interest', 'wishlist', 'manual', 'plan')),
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, place_id)
);

-- Existing trips: everything they schedule or listed as left out.
INSERT INTO trip_places (trip_id, place_id, origin)
SELECT DISTINCT s.trip_id, s.place_id, 'plan' FROM trip_stops s
ON CONFLICT DO NOTHING;
INSERT INTO trip_places (trip_id, place_id, origin)
SELECT DISTINCT t.id, u->>'placeId', 'plan'
FROM trips t, jsonb_array_elements(t.unscheduled) u
WHERE EXISTS (SELECT 1 FROM places p WHERE p.id = u->>'placeId')
ON CONFLICT DO NOTHING;

-- The stored list is no longer the source; it is recomputed from trip_places.
ALTER TABLE trips DROP COLUMN unscheduled;
