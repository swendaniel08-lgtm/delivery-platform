/**
 * The real object-storage adapter: AWS Signature V4 presigning.
 *
 * Why hand-rolled instead of `@aws-sdk/client-s3` + `s3-request-presigner`?
 *
 *   1. Those two packages pull ~90 further modules and ~15 MB into an image
 *      that runs fifteen services. We use exactly one S3 verb family —
 *      presigned PUT, presigned GET, DELETE. SigV4 query signing is ~60
 *      lines and `node:crypto` already has every primitive.
 *   2. It keeps us provider-portable. Cloudflare R2, Backblaze B2, MinIO,
 *      DigitalOcean Spaces and Wasabi all speak SigV4 with a different host
 *      and sometimes path-style addressing. Ghana-hosted egress pricing is
 *      volatile enough that we will very likely move buckets at least once.
 *
 * The important property of a presigned URL: once issued, it CANNOT be
 * recalled. Everything that limits blast radius must be baked into the
 * signature itself — short expiry, exact key, exact content-type. That is
 * why `signedHeaders` includes `content-type`: without it a rider could take
 * a proof-of-delivery URL and upload an executable to it.
 */

import { createHash, createHmac } from 'node:crypto';
import type { StoragePort } from '../media.ts';

export interface S3Config {
  /** e.g. https://s3.eu-west-1.amazonaws.com, or an R2/MinIO endpoint. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /**
   * MinIO and most self-hosted gateways need path-style
   * (`https://host/bucket/key`). AWS and R2 prefer virtual-host style.
   * Auto-detected from the endpoint unless set explicitly.
   */
  forcePathStyle?: boolean;
  /**
   * Public base for CDN-served objects. Serving menu photos from the bucket
   * origin means paying egress on every scroll of the home feed; a CDN in
   * front is not an optimisation here, it is the difference between a
   * sustainable and an unsustainable bill.
   */
  publicBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable for deterministic signature tests. */
  now?: () => Date;
}

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone, and AWS
 * rejects the signature if our canonical request escapes them differently
 * than theirs does. This has burned every hand-rolled signer ever written.
 */
export function uriEscape(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Object keys keep their slashes; each segment is escaped independently. */
export function escapeKey(key: string): string {
  return key.split('/').map(uriEscape).join('/');
}

export function amzDate(d: Date): { long: string; short: string } {
  const long = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { long, short: long.slice(0, 8) };
}

export class S3Storage implements StoragePort {
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly pathStyle: boolean;
  private readonly doFetch: typeof fetch;
  private readonly clock: () => Date;

  constructor(private readonly cfg: S3Config) {
    for (const field of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
      if (!cfg[field]) throw new Error(`S3Storage requires ${field}`);
    }
    this.endpoint = new URL(cfg.endpoint);
    this.region = cfg.region ?? 'auto';
    // Bare IPs and localhost can never be virtual-hosted — DNS would have to
    // resolve `bucket.127.0.0.1`. Default accordingly so MinIO works with no
    // extra configuration in dev.
    this.pathStyle = cfg.forcePathStyle
      ?? /^(localhost|127\.|\[?::1)/.test(this.endpoint.hostname);
    this.doFetch = cfg.fetchImpl ?? fetch;
    this.clock = cfg.now ?? (() => new Date());
  }

  /** Absolute, unsigned URL of an object. */
  urlFor(key: string): URL {
    const u = new URL(this.endpoint.toString());
    const base = u.pathname.replace(/\/+$/, '');
    if (this.pathStyle) {
      u.pathname = `${base}/${this.cfg.bucket}/${escapeKey(key)}`;
    } else {
      u.hostname = `${this.cfg.bucket}.${u.hostname}`;
      u.pathname = `${base}/${escapeKey(key)}`;
    }
    return u;
  }

  /**
   * SigV4 query-string signing.
   *
   * `expiresInSeconds` is capped at 7 days by AWS, but we cap far lower at
   * the call sites — a KYC document URL that lives for a week is a leak
   * waiting for a screenshot.
   */
  presign(input: {
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
    key: string;
    expiresInSeconds: number;
    /** Signed so the upload cannot change type after the fact. */
    contentType?: string;
    extraQuery?: Record<string, string>;
  }): string {
    if (input.expiresInSeconds <= 0 || input.expiresInSeconds > 604_800) {
      throw new Error('presign expiry must be between 1 second and 7 days');
    }

    const url = this.urlFor(input.key);
    const { long, short } = amzDate(this.clock());
    const scope = `${short}/${this.region}/s3/aws4_request`;

    // content-type must be signed AND sent, or S3 returns
    // SignatureDoesNotMatch — a failure mode that looks like bad credentials.
    const headers: Record<string, string> = { host: url.host };
    if (input.contentType) headers['content-type'] = input.contentType;

    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort()
      .map((h) => `${h}:${headers[h]!.trim()}\n`).join('');

    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKeyId}/${scope}`,
      'X-Amz-Date': long,
      'X-Amz-Expires': String(Math.floor(input.expiresInSeconds)),
      'X-Amz-SignedHeaders': signedHeaders,
      ...(input.extraQuery ?? {}),
    };

    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${uriEscape(k)}=${uriEscape(query[k]!)}`).join('&');

    const canonicalRequest = [
      input.method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      UNSIGNED_PAYLOAD,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256', long, scope, sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, short), this.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey)
      .update(stringToSign, 'utf8').digest('hex');

    url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return url.toString();
  }

  async presignPut(i: {
    key: string; contentType: string; maxBytes: number; expiresInSeconds: number;
  }): Promise<string> {
    // NOTE: `maxBytes` cannot be enforced by a presigned PUT — only by a
    // POST policy document. It IS enforced by a bucket-level lifecycle plus
    // the size check in MediaService, and re-checked on the object after
    // upload. Callers should not assume the URL itself is size-limited.
    return this.presign({
      method: 'PUT',
      key: i.key,
      contentType: i.contentType,
      expiresInSeconds: i.expiresInSeconds,
    });
  }

  async presignGet(i: { key: string; expiresInSeconds: number }): Promise<string> {
    return this.presign({ method: 'GET', key: i.key, expiresInSeconds: i.expiresInSeconds });
  }

  /**
   * Deletion is a real request, not a presign — nobody should be handed a
   * URL that erases evidence.
   */
  async delete(key: string): Promise<void> {
    const signed = this.presign({ method: 'DELETE', key, expiresInSeconds: 60 });
    const res = await this.doFetch(signed, { method: 'DELETE' });
    // 404 is success for our purposes: the object is gone either way, and a
    // retried purge job must not fail on its own second pass.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed for ${key}: HTTP ${res.status}`);
    }
  }

  /**
   * Create the bucket if it is missing. Used by dev/CI bootstrap only —
   * in production the bucket is created by infrastructure code with a
   * lifecycle policy and a block-public-access setting attached, neither of
   * which this method knows about.
   */
  async ensureBucket(): Promise<void> {
    if (await this.bucketExists()) return;
    const url = this.bucketUrl();
    const res = await this.doFetch(this.signBucket('PUT', url), { method: 'PUT' });
    // 409 = already owned by us, which is the same outcome under a race.
    if (!res.ok && res.status !== 409) {
      throw new Error(`could not create bucket ${this.cfg.bucket}: HTTP ${res.status}`);
    }
  }

  private bucketUrl(): URL {
    const url = new URL(this.endpoint.toString());
    if (this.pathStyle) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${this.cfg.bucket}`;
    } else {
      url.hostname = `${this.cfg.bucket}.${url.hostname}`;
    }
    return url;
  }

  /**
   * Boot-time preflight.
   *
   * Without this the service reports HEALTHY with a bucket that does not
   * exist, or with credentials that cannot reach it, and the failure surfaces
   * as a 404 on a rider's phone at the end of a delivery — the worst possible
   * place to discover a configuration mistake.
   */
  async bucketExists(): Promise<boolean> {
    const signed = this.signBucket('GET', this.bucketUrl());
    const res = await this.doFetch(signed, { method: 'GET' });
    if (res.ok) return true;
    if (res.status === 404) return false;
    throw new Error(
      `cannot reach bucket ${this.cfg.bucket} at ${this.endpoint.host}: HTTP ${res.status}`
      + (res.status === 403 ? ' — credentials rejected or bucket owned by another account' : ''),
    );
  }

  /** Signs a request whose resource is the bucket itself, not an object. */
  private signBucket(method: 'PUT' | 'GET', url: URL): string {
    const { long, short } = amzDate(this.clock());
    const scope = `${short}/${this.region}/s3/aws4_request`;
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.cfg.accessKeyId}/${scope}`,
      'X-Amz-Date': long,
      'X-Amz-Expires': '60',
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = Object.keys(query).sort()
      .map((k) => `${uriEscape(k)}=${uriEscape(query[k]!)}`).join('&');
    const canonicalRequest = [
      method, url.pathname, canonicalQuery, `host:${url.host}\n`, 'host', UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [
      'AWS4-HMAC-SHA256', long, scope, sha256Hex(canonicalRequest),
    ].join('\n');
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, short), this.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    const out = new URL(url.toString());
    out.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return out.toString();
  }

  publicUrlFor(key: string): string {
    if (this.cfg.publicBaseUrl) {
      return `${this.cfg.publicBaseUrl.replace(/\/+$/, '')}/${escapeKey(key)}`;
    }
    return this.urlFor(key).toString();
  }

  /**
   * Confirm an upload actually landed, and how big it really was.
   *
   * The client tells us `sizeBytes` before uploading; that number is a
   * claim. This is how we find out the truth, which matters for the media
   * that ends up in a dispute.
   */
  async head(key: string): Promise<{ exists: boolean; sizeBytes: number; contentType: string | null }> {
    // The method is part of the canonical request, so a URL signed as GET is
    // NOT valid for a HEAD request — S3 answers 403, which this function
    // would then report as "the file is not there". Every proof-of-delivery
    // verification would have come back missing.
    const signed = this.presign({ method: 'HEAD', key, expiresInSeconds: 60 });
    const res = await this.doFetch(signed, { method: 'HEAD' });
    if (res.status === 404 || res.status === 403) {
      return { exists: false, sizeBytes: 0, contentType: null };
    }
    if (!res.ok) throw new Error(`S3 head failed for ${key}: HTTP ${res.status}`);
    return {
      exists: true,
      sizeBytes: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type'),
    };
  }
}
