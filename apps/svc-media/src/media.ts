/**
 * media-svc. MASTER_PLAN §3.1.
 *
 * Uploads for menu photos, KYC documents, prescriptions, errand receipts and
 * proof-of-delivery.
 *
 * Design: the API never proxies file bytes. It issues a short-lived
 * PRESIGNED URL and the client uploads straight to S3/R2. Proxying would put
 * every rider's 4 MB delivery photo through our Node processes on Ghanaian
 * mobile data — slow for them, expensive for us, and a memory risk under load.
 *
 * Sensitive classes (KYC, prescriptions) are private and served only through
 * short-lived signed GETs; menu photos are public and CDN-cacheable.
 */

import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, ForbiddenError } from '../../../libs/platform/src/errors.ts';

export type MediaKind =
  | 'menu_item' | 'store_banner'
  | 'kyc_ghana_card' | 'kyc_selfie' | 'kyc_license' | 'kyc_vehicle'
  | 'prescription' | 'errand_receipt' | 'proof_of_delivery' | 'chat_image';

export interface KindPolicy {
  /** Public objects are CDN-cacheable; private ones need a signed GET. */
  visibility: 'public' | 'private';
  maxBytes: number;
  allowedTypes: string[];
  /** Retention in days; null means keep indefinitely. */
  retentionDays: number | null;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];

/**
 * Per-kind rules. Note the asymmetry: menu photos are generous because
 * vendors upload from cheap phones and quality sells food; rider proof photos
 * are capped tightly because they are uploaded on mobile data, at volume,
 * and only need to be legible.
 */
export const MEDIA_POLICY: Record<MediaKind, KindPolicy> = {
  menu_item:         { visibility: 'public',  maxBytes: 8_000_000, allowedTypes: IMAGE_TYPES, retentionDays: null },
  store_banner:      { visibility: 'public',  maxBytes: 8_000_000, allowedTypes: IMAGE_TYPES, retentionDays: null },
  kyc_ghana_card:    { visibility: 'private', maxBytes: 6_000_000, allowedTypes: DOC_TYPES,   retentionDays: 2555 }, // 7y
  kyc_selfie:        { visibility: 'private', maxBytes: 4_000_000, allowedTypes: IMAGE_TYPES, retentionDays: 2555 },
  kyc_license:       { visibility: 'private', maxBytes: 6_000_000, allowedTypes: DOC_TYPES,   retentionDays: 2555 },
  kyc_vehicle:       { visibility: 'private', maxBytes: 6_000_000, allowedTypes: IMAGE_TYPES, retentionDays: 2555 },
  prescription:      { visibility: 'private', maxBytes: 6_000_000, allowedTypes: DOC_TYPES,   retentionDays: 1825 }, // 5y
  errand_receipt:    { visibility: 'private', maxBytes: 4_000_000, allowedTypes: IMAGE_TYPES, retentionDays: 730 },
  proof_of_delivery: { visibility: 'private', maxBytes: 3_000_000, allowedTypes: IMAGE_TYPES, retentionDays: 365 },
  chat_image:        { visibility: 'private', maxBytes: 4_000_000, allowedTypes: IMAGE_TYPES, retentionDays: 180 },
};

/** Who may upload what. A customer must never be able to post a menu photo. */
export const KIND_ROLES: Record<MediaKind, string[]> = {
  menu_item: ['vendor_owner', 'vendor_staff', 'admin'],
  store_banner: ['vendor_owner', 'admin'],
  kyc_ghana_card: ['vendor_owner', 'rider'],
  kyc_selfie: ['vendor_owner', 'rider'],
  kyc_license: ['rider'],
  kyc_vehicle: ['rider'],
  prescription: ['customer'],
  errand_receipt: ['rider'],
  proof_of_delivery: ['rider'],
  chat_image: ['customer', 'rider', 'vendor_owner', 'vendor_staff'],
};

export interface UploadRequest {
  kind: MediaKind;
  contentType: string;
  sizeBytes: number;
  uploaderId: string;
  uploaderRole: string;
  /** Order / store / user this belongs to, for path scoping. */
  ownerRef: string;
}

export interface PresignedUpload {
  uploadUrl: string;
  /** Stored key; the caller persists this, not the URL. */
  objectKey: string;
  /** Public URL for public kinds; null for private. */
  publicUrl: string | null;
  expiresInSeconds: number;
  maxBytes: number;
  requiredHeaders: Record<string, string>;
}

export interface StoragePort {
  presignPut(input: {
    key: string; contentType: string; maxBytes: number; expiresInSeconds: number;
  }): Promise<string>;
  presignGet(input: { key: string; expiresInSeconds: number }): Promise<string>;
  delete(key: string): Promise<void>;
  publicUrlFor(key: string): string;
}

export class InMemoryStorage implements StoragePort {
  puts: string[] = [];
  deleted: string[] = [];
  async presignPut(i: { key: string }) { this.puts.push(i.key); return `https://s3.test/put/${i.key}?sig=x`; }
  async presignGet(i: { key: string }) { return `https://s3.test/get/${i.key}?sig=x`; }
  async delete(key: string) { this.deleted.push(key); }
  publicUrlFor(key: string) { return `https://cdn.besonc.app/${key}`; }
}

export const UPLOAD_URL_TTL_SECONDS = 300;   // 5 min to start the upload
export const DOWNLOAD_URL_TTL_SECONDS = 900; // 15 min to view a private object

export class MediaService {
  constructor(private readonly storage: StoragePort) {}

  /**
   * Issue a presigned upload.
   *
   * Size and type are validated HERE and re-asserted in the presigned policy,
   * so a client that lies about `sizeBytes` still cannot push a 500 MB object:
   * S3 rejects it on content-length.
   */
  async requestUpload(req: UploadRequest): Promise<PresignedUpload> {
    const policy = MEDIA_POLICY[req.kind];
    if (!policy) throw new ValidationError({ kind: [`unknown media kind: ${req.kind}`] });

    const allowedRoles = KIND_ROLES[req.kind];
    if (!allowedRoles.includes(req.uploaderRole)) {
      throw new ForbiddenError(`${req.uploaderRole} may not upload ${req.kind}`);
    }
    if (!policy.allowedTypes.includes(req.contentType)) {
      throw new ValidationError({
        contentType: [`${req.contentType} not allowed for ${req.kind}`],
      });
    }
    if (req.sizeBytes <= 0) {
      throw new ValidationError({ sizeBytes: ['must be greater than zero'] });
    }
    if (req.sizeBytes > policy.maxBytes) {
      throw new ValidationError({
        sizeBytes: [`maximum ${Math.round(policy.maxBytes / 1_000_000)}MB for ${req.kind}`],
      });
    }

    const objectKey = buildKey(req);
    const uploadUrl = await this.storage.presignPut({
      key: objectKey,
      contentType: req.contentType,
      maxBytes: policy.maxBytes,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });

    return {
      uploadUrl,
      objectKey,
      publicUrl: policy.visibility === 'public' ? this.storage.publicUrlFor(objectKey) : null,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      maxBytes: policy.maxBytes,
      requiredHeaders: { 'content-type': req.contentType },
    };
  }

  /**
   * Signed GET for a private object.
   * Authorisation is the caller's job — this only issues the URL.
   */
  async viewUrl(objectKey: string): Promise<string> {
    const kind = kindFromKey(objectKey);
    if (kind && MEDIA_POLICY[kind].visibility === 'public') {
      return this.storage.publicUrlFor(objectKey);
    }
    return this.storage.presignGet({ key: objectKey, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
  }

  async delete(objectKey: string): Promise<void> {
    await this.storage.delete(objectKey);
  }

  /** Objects past their retention window — a scheduled purge job reads this. */
  expiredBefore(kind: MediaKind, now: Date = new Date()): Date | null {
    const days = MEDIA_POLICY[kind].retentionDays;
    if (days === null) return null;
    return new Date(now.getTime() - days * 86_400_000);
  }
}

/**
 * Object key layout: kind/ownerRef/uuid.ext
 *
 * Kind first so lifecycle rules and bucket policies can target a prefix —
 * "expire proof_of_delivery/* after 365 days" is one S3 rule rather than
 * per-object metadata.
 */
export function buildKey(req: UploadRequest): string {
  const ext = extensionFor(req.contentType);
  const safeOwner = req.ownerRef.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'unknown';
  return `${req.kind}/${safeOwner}/${randomUUID()}.${ext}`;
}

export function kindFromKey(key: string): MediaKind | null {
  const prefix = key.split('/')[0] as MediaKind | undefined;
  return prefix && prefix in MEDIA_POLICY ? prefix : null;
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

/**
 * Content-hash for de-duplication.
 * Vendors re-upload the same jollof photo across many items; storing it once
 * is meaningful at scale.
 */
export function contentFingerprint(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Image variants                                                      */
/* ------------------------------------------------------------------ */

export interface ImageVariant {
  name: string;
  width: number;
  quality: number;
}

/**
 * Variants requested from the image CDN (imgproxy / Cloudflare Images).
 * A vendor's 8 MB photo must never reach a customer's phone as-is — on 3G
 * that is the whole page budget for one card.
 */
export const IMAGE_VARIANTS: ImageVariant[] = [
  { name: 'thumb', width: 160, quality: 70 },
  { name: 'card', width: 480, quality: 75 },
  { name: 'hero', width: 1080, quality: 80 },
];

export function variantUrl(baseUrl: string, variant: string): string {
  const v = IMAGE_VARIANTS.find((x) => x.name === variant);
  if (!v) throw new ValidationError({ variant: [`unknown variant: ${variant}`] });
  return `${baseUrl}?w=${v.width}&q=${v.quality}&fm=webp`;
}
