/**
 * Media ownership records.
 *
 * SECURITY. Download authorisation previously asked whether the object KEY
 * contained the caller's id:
 *
 *     if (!decoded.includes(c.sub)) throw new ForbiddenError('Not your object');
 *
 * Two things were wrong with that, and they pull in opposite directions:
 *
 *   1. It DENIED legitimate access. `buildKey` embeds `ownerRef` — usually an
 *      ORDER id — not the uploader, so the rider who took a proof photo got
 *      403 reading it back. Nobody noticed because the app uploads and never
 *      re-reads.
 *   2. It GRANTED illegitimate access. `ownerRef` is client-supplied, so an
 *      attacker who uploads once with `ownerRef` set to their own id can then
 *      read any key that merely contains that substring.
 *
 * A substring test on a client-controlled path is not an ownership check.
 * This records who uploaded what, and the check reads that row.
 */

import type { Pool } from 'pg';

export interface MediaRecord {
  objectKey: string;
  kind: string;
  ownerRef: string;
  uploaderId: string;
  uploaderRole: string;
  state: string;
}

export interface MediaRepository {
  record(input: {
    objectKey: string; kind: string; ownerRef: string;
    uploaderId: string; uploaderRole: string;
    contentType: string; sizeBytes: number; isPublic: boolean;
    expiresAt: Date | null;
  }): Promise<void>;

  find(objectKey: string): Promise<MediaRecord | null>;
}

/** Dev/test double. */
export class InMemoryMediaRepository implements MediaRepository {
  rows = new Map<string, MediaRecord>();

  async record(i: {
    objectKey: string; kind: string; ownerRef: string;
    uploaderId: string; uploaderRole: string;
  }) {
    this.rows.set(i.objectKey, {
      objectKey: i.objectKey, kind: i.kind, ownerRef: i.ownerRef,
      uploaderId: i.uploaderId, uploaderRole: i.uploaderRole,
      state: 'pending',
    });
  }

  async find(objectKey: string) { return this.rows.get(objectKey) ?? null; }
}

export class PgMediaRepository implements MediaRepository {
  constructor(private readonly pool: Pool) {}

  async record(i: {
    objectKey: string; kind: string; ownerRef: string;
    uploaderId: string; uploaderRole: string;
    contentType: string; sizeBytes: number; isPublic: boolean;
    expiresAt: Date | null;
  }): Promise<void> {
    // Written when the presigned URL is ISSUED, not after upload. The row is
    // the authorisation record; if it only appeared on confirmation there
    // would be a window where a key exists with no owner, and the safe
    // behaviour then is to deny the uploader their own object.
    await this.pool.query(
      `INSERT INTO media_objects
         (object_key, kind, owner_ref, uploader_id, uploader_role,
          content_type, size_bytes, is_public, expires_at, state)
       VALUES ($1, $2::media_kind, $3, $4, $5, $6, $7, $8, $9, 'pending')
       ON CONFLICT (object_key) DO NOTHING`,
      [
        i.objectKey, i.kind, i.ownerRef, i.uploaderId, i.uploaderRole,
        i.contentType, i.sizeBytes, i.isPublic, i.expiresAt,
      ],
    );
  }

  async find(objectKey: string): Promise<MediaRecord | null> {
    const { rows } = await this.pool.query<{
      object_key: string; kind: string; owner_ref: string;
      uploader_id: string; uploader_role: string; state: string;
    }>(
      `SELECT object_key, kind, owner_ref, uploader_id, uploader_role, state
         FROM media_objects
        WHERE object_key = $1 AND deleted_at IS NULL`,
      [objectKey],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      objectKey: r.object_key,
      kind: r.kind,
      ownerRef: r.owner_ref,
      uploaderId: r.uploader_id,
      uploaderRole: r.uploader_role,
      state: r.state,
    };
  }
}
