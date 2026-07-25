-- svc-catalogue · 001_catalogue
-- ONE template serving all 6 catalogue services (PDF §2).
-- search-svc is merged in here (MASTER_PLAN §1.3) so search owns its own
-- index rather than reading another service's replica (issue #11).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TYPE service_type AS ENUM (
  'food', 'groceries', 'shop', 'market', 'pharmacy', 'laundry'
);
CREATE TYPE store_status AS ENUM ('pending_review', 'approved', 'suspended', 'rejected');
CREATE TYPE laundry_pricing_model AS ENUM ('per_item', 'per_bag');

CREATE TABLE stores (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               UUID NOT NULL,               -- identity-svc user, via API
  service_type           service_type NOT NULL,
  name                   TEXT NOT NULL,
  description            TEXT,
  image_urls             JSONB NOT NULL DEFAULT '[]'::jsonb,
  latitude               DOUBLE PRECISION NOT NULL,
  longitude              DOUBLE PRECISION NOT NULL,
  landmark               TEXT,
  phone                  TEXT NOT NULL,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  is_open_override       BOOLEAN,                     -- NULL = follow schedule
  operating_hours        JSONB NOT NULL DEFAULT '{}'::jsonb,
  holiday_closures       JSONB NOT NULL DEFAULT '[]'::jsonb,
  average_rating         NUMERIC(3,2) NOT NULL DEFAULT 0,
  total_orders           INTEGER NOT NULL DEFAULT 0,
  average_prep_minutes   INTEGER NOT NULL DEFAULT 20,
  pharmacy_license_number TEXT,
  status                 store_status NOT NULL DEFAULT 'pending_review',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT stores_lat_range CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT stores_lng_range CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT stores_rating_range CHECK (average_rating BETWEEN 0 AND 5),
  -- PDF §2: pharmacies may not go live without a licence on file
  CONSTRAINT stores_pharmacy_licensed CHECK (
    service_type <> 'pharmacy'
    OR status <> 'approved'
    OR pharmacy_license_number IS NOT NULL
  )
);
CREATE INDEX stores_service_status_idx ON stores (service_type, status) WHERE is_active;
CREATE INDEX stores_owner_idx ON stores (owner_id);

CREATE TABLE categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   UUID NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX categories_store_idx ON categories (store_id, sort_order);

CREATE TABLE items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id              UUID NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  category_id           UUID REFERENCES categories (id) ON DELETE SET NULL,
  name                  TEXT NOT NULL,
  description           TEXT,
  image_urls            JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- MONEY IS INTEGER PESEWAS (issue #5). Never NUMERIC, never float.
  base_price_pesewas    BIGINT NOT NULL CHECK (base_price_pesewas >= 0),
  unit                  TEXT,          -- 'per piece' | 'per kg' | 'per bowl' …
  is_available          BOOLEAN NOT NULL DEFAULT true,
  requires_prescription BOOLEAN NOT NULL DEFAULT false,
  substitution_allowed  BOOLEAN NOT NULL DEFAULT true,
  prep_minutes          INTEGER,
  laundry_model         laundry_pricing_model,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- search vector maintained by trigger below
  search_tsv            TSVECTOR
);
CREATE INDEX items_store_idx     ON items (store_id) WHERE is_available;
CREATE INDEX items_category_idx  ON items (category_id, sort_order);
CREATE INDEX items_search_idx    ON items USING GIN (search_tsv);
CREATE INDEX items_name_trgm_idx ON items USING GIN (name gin_trgm_ops);

-- Addon groups (food): "Protein", required, pick 1–3
CREATE TABLE addon_groups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        UUID NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  is_required    BOOLEAN NOT NULL DEFAULT false,
  min_selections INTEGER NOT NULL DEFAULT 0,
  max_selections INTEGER NOT NULL DEFAULT 1,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT addon_group_selection_range CHECK (
    min_selections >= 0
    AND max_selections >= min_selections
    -- a required group must force at least one pick
    AND (NOT is_required OR min_selections >= 1)
  )
);
CREATE INDEX addon_groups_item_idx ON addon_groups (item_id, sort_order);

CREATE TABLE addon_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  addon_group_id UUID NOT NULL REFERENCES addon_groups (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  price_pesewas  BIGINT NOT NULL DEFAULT 0 CHECK (price_pesewas >= 0),
  is_available   BOOLEAN NOT NULL DEFAULT true,
  sort_order     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX addon_items_group_idx ON addon_items (addon_group_id, sort_order);

-- Variant groups (shop): "Colour", pick exactly 1
CREATE TABLE variant_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    UUID NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE variant_options (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_group_id UUID NOT NULL REFERENCES variant_groups (id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  price_delta_pesewas BIGINT NOT NULL DEFAULT 0,
  is_available     BOOLEAN NOT NULL DEFAULT true,
  sort_order       INTEGER NOT NULL DEFAULT 0
);

/* ------------------------------------------------------------------ */
/* Search index — owned by this service (closes issue #11)             */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION items_search_refresh() RETURNS TRIGGER AS $$
BEGIN
  NEW.search_tsv :=
      setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'A')
   || setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'B');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_items_search
  BEFORE INSERT OR UPDATE OF name, description ON items
  FOR EACH ROW EXECUTE FUNCTION items_search_refresh();

/* ------------------------------------------------------------------ */
/* Vendor ranking (PDF §10)                                            */
/* Score = 0.3 proximity + 0.3 rating + 0.2 volume + 0.2 prep speed    */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION store_rank_score(
  distance_metres DOUBLE PRECISION,
  rating          NUMERIC,
  orders_30d      INTEGER,
  prep_minutes    INTEGER
) RETURNS DOUBLE PRECISION AS $$
  SELECT
      0.3 * (1.0 / (1.0 + GREATEST(distance_metres, 0) / 3000.0))
    + 0.3 * (LEAST(GREATEST(rating, 0), 5) / 5.0)
    + 0.2 * LEAST(GREATEST(orders_30d, 0)::DOUBLE PRECISION / 500.0, 1.0)
    + 0.2 * (1.0 / (1.0 + GREATEST(prep_minutes, 1)::DOUBLE PRECISION / 20.0));
$$ LANGUAGE sql IMMUTABLE;

/* Is the store open right now? Manual override beats the schedule. */
CREATE OR REPLACE FUNCTION store_is_open(
  hours JSONB, override BOOLEAN, at_time TIMESTAMPTZ DEFAULT now()
) RETURNS BOOLEAN AS $$
DECLARE
  day_key TEXT;
  slot    JSONB;
  t       TIME;
BEGIN
  IF override IS NOT NULL THEN RETURN override; END IF;
  day_key := lower(to_char(at_time AT TIME ZONE 'Africa/Accra', 'dy'));
  slot := hours -> day_key;
  IF slot IS NULL OR slot = 'null'::jsonb THEN RETURN false; END IF;
  t := (at_time AT TIME ZONE 'Africa/Accra')::TIME;
  RETURN t >= (slot ->> 'open')::TIME AND t < (slot ->> 'close')::TIME;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stores_touch BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
