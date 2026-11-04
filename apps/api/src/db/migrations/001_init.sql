-- RIFLO initial schema (PostgreSQL 15+). Runs unchanged on PGlite for dev and tests.

CREATE TABLE cities (
  id          text PRIMARY KEY,
  name_ar     text NOT NULL,
  name_en     text,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  active      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE,
  phone         text UNIQUE,
  display_name  text,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'editor', 'admin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- One-time sign-in codes. Only a hash is stored.
CREATE TABLE login_codes (
  id          bigserial PRIMARY KEY,
  identifier  text NOT NULL,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_codes_identifier_idx ON login_codes (identifier, created_at DESC);

CREATE TABLE places (
  id               text PRIMARY KEY,
  city_id          text NOT NULL REFERENCES cities(id),
  name_ar          text NOT NULL,
  summary_ar       text NOT NULL DEFAULT '',
  category         text NOT NULL CHECK (category IN ('religious', 'history', 'nature', 'market', 'food', 'museum')),
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  visit_minutes    int NOT NULL CHECK (visit_minutes > 0),
  cost_per_person  numeric(10, 2) CHECK (cost_per_person >= 0),  -- NULL = unknown
  opening_hours    text,                                           -- NULL = not entered
  best_time        text NOT NULL DEFAULT 'any' CHECK (best_time IN ('morning', 'afternoon', 'evening', 'any')),
  etiquette        text,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'published', 'hidden')),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX places_city_status_idx ON places (city_id, status);

CREATE TABLE place_photos (
  id          bigserial PRIMARY KEY,
  place_id    text NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  url         text NOT NULL,
  alt_ar      text NOT NULL DEFAULT '',
  credit      text,
  position    int NOT NULL DEFAULT 0
);
CREATE INDEX place_photos_place_idx ON place_photos (place_id, position);

CREATE TABLE trips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city_id            text NOT NULL REFERENCES cities(id),
  title              text NOT NULL,
  start_date         date NOT NULL,
  end_date           date NOT NULL,
  travellers         int NOT NULL CHECK (travellers BETWEEN 1 AND 20),
  trip_type          text NOT NULL CHECK (trip_type IN ('family', 'friends', 'solo', 'couple')),
  budget_total       numeric(12, 2) NOT NULL CHECK (budget_total >= 0),
  interests          text[] NOT NULL DEFAULT '{}',
  around_prayer      boolean NOT NULL DEFAULT true,
  relaxed_pace       boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'completed', 'archived')),
  reused_from        uuid REFERENCES trips(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX trips_user_idx ON trips (user_id, start_date);

CREATE TABLE trip_days (
  trip_id    uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_index  int NOT NULL,
  date       date NOT NULL,
  breaks     jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (trip_id, day_index)
);

CREATE TABLE trip_stops (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          uuid NOT NULL,
  day_index        int NOT NULL,
  position         int NOT NULL,
  place_id         text NOT NULL REFERENCES places(id),
  start_minute     int NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  travel_minutes   int,
  distance_km      numeric(6, 1),
  FOREIGN KEY (trip_id, day_index) REFERENCES trip_days(trip_id, day_index) ON DELETE CASCADE,
  UNIQUE (trip_id, day_index, position)
);
CREATE INDEX trip_stops_place_idx ON trip_stops (place_id);

CREATE TABLE visits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id    text NOT NULL REFERENCES places(id),
  trip_id     uuid REFERENCES trips(id) ON DELETE SET NULL,
  visited_on  date NOT NULL,
  rating      smallint CHECK (rating BETWEEN 1 AND 5),
  note        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, place_id, visited_on)
);
CREATE INDEX visits_place_idx ON visits (place_id);

CREATE TABLE wishlist (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id    text NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, place_id)
);

-- The "pre-filled next trip": last preferences, minus dates.
CREATE TABLE user_preferences (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences  jsonb NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id     text NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  kind         text NOT NULL DEFAULT 'wrong_info' CHECK (kind IN ('wrong_info', 'closed', 'suggestion', 'complaint')),
  message      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by  uuid REFERENCES users(id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_open_idx ON reports (status, place_id);

-- Product analytics for the admin funnel. anonymous_id covers guests before sign-up.
CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  anonymous_id  text,
  name          text NOT NULL CHECK (name IN ('plan_started', 'plan_step_completed', 'plan_ready', 'trip_saved', 'visit_logged', 'plan_reused')),
  props         jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_name_time_idx ON events (name, created_at);

-- Every admin/editor change, for accountability.
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text NOT NULL,
  changes     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id, created_at DESC);
