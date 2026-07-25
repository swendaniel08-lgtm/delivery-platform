-- svc-identity · 001_identity
-- Users, sessions, addresses, KYC. MASTER_PLAN §3.1.
-- identity-svc = auth-svc + user-svc merged (§1.3): same aggregate root.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE user_role   AS ENUM ('customer', 'vendor_owner', 'vendor_staff', 'rider', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'pending_review', 'rejected', 'deleted');
CREATE TYPE vehicle_type AS ENUM ('bicycle', 'motorbike', 'car');
CREATE TYPE kyc_status  AS ENUM ('not_submitted', 'pending', 'approved', 'rejected');

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             TEXT        NOT NULL UNIQUE,           -- E.164, always +233…
  email             TEXT UNIQUE,
  role              user_role   NOT NULL,
  first_name        TEXT,
  last_name         TEXT,
  profile_image_url TEXT,
  phone_verified    BOOLEAN     NOT NULL DEFAULT false,
  status            user_status NOT NULL DEFAULT 'active',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_phone_e164 CHECK (phone ~ '^\+233[2356]\d{8}$')
);
CREATE INDEX users_role_status_idx ON users (role, status);

-- Ghana addresses: the GPS pin is primary, everything else is a hint. §3.7.
CREATE TABLE addresses (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  label                 TEXT NOT NULL DEFAULT 'Home',
  latitude              DOUBLE PRECISION NOT NULL,
  longitude             DOUBLE PRECISION NOT NULL,
  ghanapost_address     TEXT,                              -- optional, e.g. GA-123-4567
  area_name             TEXT,                              -- from reverse geocoding
  landmark              TEXT,                              -- prominent in the UI
  delivery_instructions TEXT,
  contact_phone         TEXT,
  is_default            BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT addresses_lat_range CHECK (latitude  BETWEEN -90  AND 90),
  CONSTRAINT addresses_lng_range CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT addresses_ghanapost_fmt
    CHECK (ghanapost_address IS NULL OR ghanapost_address ~ '^[A-Z]{2}-\d{3,4}-\d{4}$')
);
CREATE INDEX addresses_user_idx ON addresses (user_id);
CREATE UNIQUE INDEX addresses_one_default_per_user
  ON addresses (user_id) WHERE is_default;

CREATE TABLE rider_profiles (
  user_id             UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  ghana_card_number   TEXT NOT NULL,
  ghana_card_front_url TEXT,
  ghana_card_back_url  TEXT,
  selfie_url          TEXT,
  date_of_birth       DATE,
  emergency_contact   TEXT,
  zone                TEXT,
  vehicle             vehicle_type NOT NULL,
  license_plate       TEXT,
  drivers_license_url TEXT,
  vehicle_image_url   TEXT,
  kyc                 kyc_status NOT NULL DEFAULT 'not_submitted',
  kyc_rejection_reason TEXT,
  is_online           BOOLEAN NOT NULL DEFAULT false,
  approved_at         TIMESTAMPTZ,
  approved_by         UUID REFERENCES users (id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- motorbike and car riders must have a plate and a licence
  CONSTRAINT rider_vehicle_docs CHECK (
    vehicle = 'bicycle' OR (license_plate IS NOT NULL AND drivers_license_url IS NOT NULL)
  )
);

CREATE TABLE vendor_profiles (
  user_id            UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  ghana_card_number  TEXT NOT NULL,
  business_reg_number TEXT,
  kyc                kyc_status NOT NULL DEFAULT 'not_submitted',
  kyc_rejection_reason TEXT,
  approved_at        TIMESTAMPTZ,
  approved_by        UUID REFERENCES users (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh-token rotation: each session row is one token family.
-- Reuse of a rotated token means theft → revoke the whole family.
CREATE TABLE sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  device_id          TEXT,
  user_agent         TEXT,
  ip                 INET,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  replaced_by        UUID REFERENCES sessions (id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx  ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX sessions_token_idx ON sessions (refresh_token_hash);

-- Audit of every OTP send: fraud forensics + SMS spend reconciliation.
CREATE TABLE otp_audit (
  id           BIGSERIAL PRIMARY KEY,
  phone        TEXT NOT NULL,
  ip           INET,
  device_id    TEXT,
  provider     TEXT,
  succeeded    BOOLEAN NOT NULL,
  failure_reason TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX otp_audit_phone_time_idx ON otp_audit (phone, created_at DESC);
CREATE INDEX otp_audit_time_idx       ON otp_audit (created_at DESC);

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
