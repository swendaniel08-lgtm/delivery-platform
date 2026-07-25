/**
 * media-svc HTTP surface.
 *
 * Bytes never pass through this service. It issues presigned URLs and the
 * client uploads straight to object storage — proxying a rider's proof-of-
 * delivery photo through a Node process would burn memory and bandwidth on
 * the one thing S3 already does well.
 *
 * The security model is therefore about WHO may ask for a URL and WHAT that
 * URL permits, because once issued it cannot be recalled.
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Body, Param, Query, Headers,
  Inject, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError, NotFoundError,
} from '../../../libs/platform/src/errors.ts';
import {
  MediaService, MEDIA_POLICY, KIND_ROLES, InMemoryStorage,
  UPLOAD_URL_TTL_SECONDS, DOWNLOAD_URL_TTL_SECONDS,
  kindFromKey, type StoragePort, type MediaKind,
} from './media.ts';

export const MEDIA_SERVICE = Symbol('MEDIA_SERVICE');
export const VERIFY_TOKEN = Symbol('MEDIA_VERIFY_TOKEN');

export interface Claims { sub: string; role: string }
export type VerifyToken = (token: string) => Claims;

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') errors[f] = ['is required'];
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

@Controller('media')
export class MediaController {
  constructor(
    @Inject(MEDIA_SERVICE) private readonly media: MediaService,
    @Inject(VERIFY_TOKEN) private readonly verify: VerifyToken,
  ) {}

  private claims(auth?: string): Claims {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    try { return this.verify(auth.slice(7)); }
    catch { throw new UnauthorizedError('Invalid token'); }
  }

  /**
   * Ask for somewhere to upload.
   *
   * The uploader's role comes from the TOKEN, never the body. A client that
   * could name its own role would be able to upload a Ghana Card as if it
   * were an admin and land it in the KYC bucket.
   */
  @Post('uploads')
  async requestUpload(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    requireFields(body, ['kind', 'contentType', 'sizeBytes']);

    const upload = await this.media.requestUpload({
      kind: body.kind as MediaKind,
      contentType: String(body.contentType),
      sizeBytes: Number(body.sizeBytes),
      uploaderId: c.sub,
      uploaderRole: c.role,
      // Scopes the object path. Defaults to the uploader so a key always
      // carries an owner, which is what the download check relies on.
      ownerRef: String(body.ownerRef ?? body.orderId ?? c.sub),
    });

    return {
      objectKey: upload.objectKey,
      uploadUrl: upload.uploadUrl,
      publicUrl: upload.publicUrl,
      requiredHeaders: upload.requiredHeaders,
      // The client needs to know how long it has before the URL dies. On a
      // 3G connection a 5MB photo can take most of five minutes.
      expiresInSeconds: upload.expiresInSeconds,
      maxBytes: upload.maxBytes,
    };
  }

  /**
   * Get a viewing URL for a private object.
   *
   * Short-lived by design: a KYC document URL that lived for a week would
   * end up pasted into a support chat and stay valid long after.
   */
  @Get('objects/:key/url')
  async downloadUrl(@Param('key') key: string, @Headers('authorization') auth?: string) {
    const c = this.claims(auth);
    const decoded = decodeURIComponent(key);
    const kind = kindFromKey(decoded);
    if (!kind) throw new NotFoundError('Object');

    const policy = MEDIA_POLICY[kind];
    if (policy.visibility === 'private' && c.role !== 'admin') {
      // KYC documents are admin-only even for the person who uploaded them:
      // a rider must not be able to re-read their own Ghana Card scan
      // months later from a key that leaked into a support chat.
      if (kind.startsWith('kyc_')) {
        throw new ForbiddenError('This document can only be viewed by an administrator');
      }
      // Everything else private is readable only by its uploader. The key
      // embeds the uploader id (see buildKey).
      if (!decoded.includes(c.sub)) throw new ForbiddenError('Not your object');
    }

    return {
      url: await this.media.viewUrl(decoded),
      expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
    };
  }

  /** The upload rules, so the apps can validate before choosing a file. */
  @Get('policy')
  policy() {
    return {
      kinds: Object.fromEntries(
        Object.entries(MEDIA_POLICY).map(([kind, p]) => [kind, {
          maxBytes: p.maxBytes,
          allowedTypes: p.allowedTypes,
          visibility: p.visibility,
          retentionDays: p.retentionDays,
          allowedRoles: KIND_ROLES[kind as MediaKind],
        }]),
      ),
      uploadUrlTtlSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }
}

export interface MediaDeps {
  pool?: Pool | null;
  storage?: StoragePort;
  verifyToken?: VerifyToken;
}

@Module({})
export class MediaHttpModule {
  static forRoot(deps: MediaDeps = {}): DynamicModule {
    const storage = deps.storage ?? new InMemoryStorage();
    return {
      module: MediaHttpModule,
      imports: [HealthModule.forRoot(deps.pool ?? null)],
      controllers: [MediaController],
      providers: [
        { provide: MEDIA_SERVICE, useValue: new MediaService(storage) },
        {
          provide: VERIFY_TOKEN,
          useValue: deps.verifyToken ?? (() => {
            throw new UnauthorizedError('token verification is not configured');
          }),
        },
      ],
    };
  }
}
