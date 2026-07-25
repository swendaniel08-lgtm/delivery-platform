-- svc-media · 001_media
-- Object registry, retention and de-duplication.
--
-- The bytes live in S3/R2; this table is the index. It exists so that:
--   * a retention job can find KYC documents older than 7 years,
--   * an identical re-upload can be de-duplicated by content hash,
--   * an orphaned upload (URL issued, file never sent) can be reaped.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE media_kind AS ENUM (
  'menu_item', 'store_banner',
  'kyc_ghana_card', 'kyc_selfie', 'kyc_license', 'kyc_vehicle',
  'prescription', 'errand_receipt', 'proof_of_delivery', 'chat_image'
);
CREATE TYPE media_state AS ENUM ('pending', 'stored', 'failed', 'deleted');

CREATE TABLE media_objects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_key    TEXT NOT NULL UNIQUE,
  kind          media_kind NOT NULL,
  owner_ref     TEXT NOT NULL,
  uploader_id   UUID NOT NULL,
  uploader_role TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    BIGINT CHECK (size_bytes IS NULL OR size_bytes > 0),
  -- sha256 of the bytes, set on confirmation. Vendors re-upload the same
  -- jollof photo across many items; storing it once is worth doing.
  content_hash  TEXT,
  state         media_state NOT NULL DEFAULT 'pending',
  is_public     BOOLEAN NOT NULL DEFAULT false,
  -- NULL means keep indefinitely (menu photos).
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ,

  CONSTRAINT media_confirmed_has_time CHECK (
    state <> 'stored' OR confirmed_at IS NOT NULL
  ),
  -- Defence in depth: sensitive classes must never be flagged public, even
  -- if application code is wrong.
  CONSTRAINT media_private_kinds CHECK (
    NOT is_public OR kind IN ('menu_item', 'store_banner')
  )
);

CREATE INDEX media_owner_idx ON media_objects (kind, owner_ref)
  WHERE state = 'stored';
CREATE INDEX media_hash_idx  ON media_objects (content_hash)
  WHERE content_hash IS NOT NULL AND state = 'stored';

-- The retention job scans this; it stays small because expired rows leave it.
CREATE INDEX media_expiry_idx ON media_objects (expires_at)
  WHERE state = 'stored' AND expires_at IS NOT NULL;

-- Orphans: a presigned URL was issued but the client never uploaded.
CREATE INDEX media_pending_idx ON media_objects (created_at)
  WHERE state = 'pending';

/* ---------------------------------------------------------------- */
/* Links — what an object belongs to                                 */
/* ---------------------------------------------------------------- */

CREATE TABLE media_links (
  media_id    UUID NOT NULL REFERENCES media_objects (id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,      -- Order, Item, Rider, Vendor, ChatMessage
  entity_id   TEXT NOT NULL,
  position    SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (media_id, entity_type, entity_id)
);
CREATE INDEX media_links_entity_idx ON media_links (entity_type, entity_id, position);

/* ---------------------------------------------------------------- */
/* Access log for private objects                                    */
/* ---------------------------------------------------------------- */

/*
 * Who viewed a Ghana Card, and when.
 *
 * KYC documents are the most sensitive data on the platform. An admin
 * browsing rider identity documents without a reason is exactly the abuse
 * this table makes visible.
 */
CREATE TABLE media_access_log (
  id          BIGSERIAL PRIMARY KEY,
  media_id    UUID NOT NULL REFERENCES media_objects (id) ON DELETE CASCADE,
  viewer_id   UUID NOT NULL,
  viewer_role TEXT NOT NULL,
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX media_access_viewer_idx ON media_access_log (viewer_id, created_at DESC);
CREATE INDEX media_access_object_idx ON media_access_log (media_id, created_at DESC);

/* ---------------------------------------------------------------- */
/* Maintenance                                                       */
/* ---------------------------------------------------------------- */

/* Objects past retention — the purge job claims a batch at a time. */
CREATE OR REPLACE FUNCTION expired_media(batch INTEGER DEFAULT 200)
RETURNS TABLE (id UUID, object_key TEXT, kind media_kind) AS $$
  SELECT m.id, m.object_key, m.kind
  FROM media_objects m
  WHERE m.state = 'stored'
    AND m.expires_at IS NOT NULL
    AND m.expires_at < now()
  ORDER BY m.expires_at
  LIMIT batch;
$$ LANGUAGE sql STABLE;

/*
 * Presigned URLs that were never used.
 *
 * Without this, a customer who abandons a prescription upload leaves a
 * permanent 'pending' row, and the table grows without bound.
 */
CREATE OR REPLACE FUNCTION orphaned_uploads(
  older_than INTERVAL DEFAULT INTERVAL '1 hour', batch INTEGER DEFAULT 200
)
RETURNS TABLE (id UUID, object_key TEXT) AS $$
  SELECT m.id, m.object_key
  FROM media_objects m
  WHERE m.state = 'pending' AND m.created_at < now() - older_than
  ORDER BY m.created_at
  LIMIT batch;
$$ LANGUAGE sql STABLE;
