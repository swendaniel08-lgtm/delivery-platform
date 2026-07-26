/**
 * identity-svc HTTP surface.
 *
 * Auth in Besonc is phone + OTP only — no passwords. There is no meaningful
 * password-reset story for a market trader with a shared handset, and every
 * Ghanaian delivery app the users already know works this way.
 *
 * Flow: POST /auth/otp/request → SMS → POST /auth/otp/verify → token pair.
 * The verify step creates the account if the number is new, so signup and
 * login are the same endpoint (MASTER_PLAN §3.1).
 */

import 'reflect-metadata';
import {
  Module, Controller, Get, Post, Patch, Delete, Body, Param, Req, Headers,
  Inject, Injectable, type DynamicModule,
} from '@nestjs/common';
import type { Pool } from 'pg';

import { HealthModule } from '../../../libs/platform/src/service/bootstrap.ts';
import {
  ValidationError, UnauthorizedError, ForbiddenError,
} from '../../../libs/platform/src/errors.ts';
import {
  OtpService, InMemoryCounterStore,
  type CounterStore, type OtpLimits,
} from './otp/otp-service.ts';
import {
  TokenService, InMemorySessionStore, DEFAULT_TOKEN_CONFIG,
  type SessionStore, type Role, type Principal,
} from './token/token-service.ts';
import {
  InMemorySmsProvider, normaliseGhanaPhone, InvalidPhoneError,
  type SmsProvider,
} from './sms/provider.ts';
import {
  InMemoryUserRepository, PgUserRepository, PgSessionStore,
  type UserRepository, type UserRow, type AddressRow,
} from './repository.ts';

/**
 * Resolves the store a vendor owns.
 *
 * The vendor BFF reads `vendorId` from the access token and refuses every
 * request without it, so a login that does not stamp it locks the vendor
 * out entirely with "No store is linked to this account".
 *
 * A port rather than a call into catalogue-svc: identity must be able to
 * mint a token even when the catalogue is down, and a vendor whose store
 * lookup failed is better served by a token with no vendorId (they see the
 * onboarding screen) than by no token at all.
 */
export interface StoreLookup {
  storeIdFor(ownerId: string): Promise<string | null>;
}

export const OTP_SERVICE = Symbol('OTP_SERVICE');
export const STORE_LOOKUP = Symbol('STORE_LOOKUP');
export const TOKEN_SERVICE = Symbol('TOKEN_SERVICE');
export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

const SIGNUP_ROLES: Role[] = ['customer', 'vendor_owner', 'rider'];

/* ------------------------------------------------------------------ */
/* Wire shapes                                                         */
/* ------------------------------------------------------------------ */

function userDto(u: UserRow) {
  return {
    id: u.id,
    phone: u.phone,
    email: u.email,
    role: u.role,
    firstName: u.first_name,
    lastName: u.last_name,
    phoneVerified: u.phone_verified,
    status: u.status,
  };
}

function addressDto(a: AddressRow) {
  return {
    id: a.id,
    label: a.label,
    latitude: Number(a.latitude),
    longitude: Number(a.longitude),
    ghanapostAddress: a.ghanapost_address,
    areaName: a.area_name,
    landmark: a.landmark,
    deliveryInstructions: a.delivery_instructions,
    contactPhone: a.contact_phone,
    isDefault: a.is_default,
  };
}

function requireFields(body: any, fields: string[]): void {
  const errors: Record<string, string[]> = {};
  for (const f of fields) {
    if (body?.[f] === undefined || body[f] === null || body[f] === '') {
      errors[f] = ['is required'];
    }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

/** Client IP, honouring the gateway's X-Forwarded-For. Used for rate limits. */
function clientIp(req: any, header?: string): string {
  const fwd = (header ?? req?.headers?.['x-forwarded-for']) as string | undefined;
  if (fwd) return fwd.split(',')[0]!.trim();
  return req?.ip ?? req?.socket?.remoteAddress ?? '0.0.0.0';
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(OTP_SERVICE) private readonly otp: OtpService,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(STORE_LOOKUP) private readonly stores: StoreLookup,
  ) {}

  @Post('otp/request')
  async requestOtp(
    @Body() body: any,
    @Req() req: any,
    @Headers('x-device-id') deviceHeader?: string,
    @Headers('x-forwarded-for') fwd?: string,
  ) {
    requireFields(body, ['phone']);
    // The device id anchors one of the five rate-limit axes. A client that
    // omits it falls back to its IP, which is stricter, not looser.
    const deviceId = body.deviceId ?? deviceHeader ?? clientIp(req, fwd);
    const result = await this.otp.request({
      phone: String(body.phone),
      ip: clientIp(req, fwd),
      deviceId: String(deviceId),
    });
    return {
      phone: result.phone,
      expiresInSeconds: result.expiresInSeconds,
      // The provider name is useful in support calls ("did it go via Hubtel?")
      provider: result.provider,
      ...(result.debugCode ? { debugCode: result.debugCode } : {}),
    };
  }

  @Post('otp/verify')
  async verifyOtp(@Body() body: any, @Headers('x-device-id') deviceHeader?: string) {
    requireFields(body, ['phone', 'code']);
    const role = (body.role ?? 'customer') as Role;
    if (!SIGNUP_ROLES.includes(role)) {
      throw new ValidationError({ role: [`must be one of ${SIGNUP_ROLES.join(', ')}`] });
    }

    const { phone } = await this.otp.verify(String(body.phone), String(body.code));
    const before = await this.users.findByPhone(phone);
    const user = await this.users.upsertVerified(phone, role);

    if (user.status === 'suspended' || user.status === 'deleted') {
      throw new ForbiddenError('This account is not active. Contact Besonc support.');
    }

    const principal: Principal = { userId: user.id, role: user.role };

    // Vendors carry their store id in the token; every vendor-BFF route
    // scopes on it. Failing the lookup must not fail the login.
    if (user.role === 'vendor_owner' || user.role === 'vendor_staff') {
      const storeId = await this.stores.storeIdFor(user.id).catch(() => null);
      if (storeId) principal.vendorId = storeId;
    }

    const pair = await this.tokens.issue(principal, body.deviceId ?? deviceHeader);

    return {
      // The apps branch on this: new users go to the profile screen,
      // returning users straight to home.
      isNewUser: before === null,
      user: userDto(user),
      tokens: pair,
    };
  }

  @Post('token/refresh')
  async refresh(@Body() body: any, @Headers('x-device-id') deviceHeader?: string) {
    requireFields(body, ['refreshToken']);
    const raw = String(body.refreshToken);
    const sessionId = raw.split('.')[0];
    if (!sessionId) throw new UnauthorizedError('Malformed refresh token');

    // We must know WHO the token belongs to before rotating. Rather than
    // trusting the client's claim, we resolve the user from the session row.
    const owner = await this.tokens.userForRefreshToken(raw);
    const user = await this.users.findById(owner);
    if (!user) throw new UnauthorizedError('Invalid refresh token');

    const pair = await this.tokens.refresh(
      raw, { userId: user.id, role: user.role }, body.deviceId ?? deviceHeader,
    );
    return { tokens: pair };
  }

  @Post('logout')
  async logout(@Headers('authorization') auth?: string) {
    const claims = this.requireClaims(auth);
    const revoked = await this.tokens.revokeAll(claims.sub, 'logout');
    return { revokedSessions: revoked };
  }

  /** Used by the gateway and BFFs to turn a bearer token into a principal. */
  @Post('token/introspect')
  introspect(@Body() body: any) {
    requireFields(body, ['token']);
    try {
      const c = this.tokens.verifyAccess(String(body.token));
      return { active: true, sub: c.sub, role: c.role, exp: c.exp, jti: c.jti };
    } catch {
      // Introspection of a bad token is a valid answer, not an error.
      return { active: false };
    }
  }

  private requireClaims(auth?: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    return this.tokens.verifyAccess(auth.slice(7));
  }
}

/* ------------------------------------------------------------------ */
/* Users + addresses                                                   */
/* ------------------------------------------------------------------ */

@Controller('users')
export class UserController {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  private me(auth?: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedError();
    return this.tokens.verifyAccess(auth.slice(7));
  }

  @Get('me')
  async profile(@Headers('authorization') auth?: string) {
    const c = this.me(auth);
    const u = await this.users.findById(c.sub);
    if (!u) throw new UnauthorizedError('Account no longer exists');
    return userDto(u);
  }

  @Patch('me')
  async update(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.me(auth);
    if (body?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(body.email))) {
      throw new ValidationError({ email: ['is not a valid email address'] });
    }
    const u = await this.users.updateProfile(c.sub, {
      ...(body?.firstName !== undefined ? { firstName: String(body.firstName) } : {}),
      ...(body?.lastName !== undefined ? { lastName: String(body.lastName) } : {}),
      ...(body?.email !== undefined ? { email: body.email === null ? null : String(body.email) } : {}),
    });
    return userDto(u);
  }

  @Get('me/addresses')
  async listAddresses(@Headers('authorization') auth?: string) {
    const c = this.me(auth);
    return { addresses: (await this.users.listAddresses(c.sub)).map(addressDto) };
  }

  @Post('me/addresses')
  async addAddress(@Body() body: any, @Headers('authorization') auth?: string) {
    const c = this.me(auth);
    requireFields(body, ['latitude', 'longitude']);
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    const errors: Record<string, string[]> = {};
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.latitude = ['must be between -90 and 90'];
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.longitude = ['must be between -180 and 180'];
    // GhanaPostGPS is optional but must be well-formed when supplied (§3.7).
    if (body.ghanapostAddress && !/^[A-Z]{2}-\d{3,4}-\d{4}$/.test(String(body.ghanapostAddress))) {
      errors.ghanapostAddress = ['must look like GA-123-4567'];
    }
    if (body.contactPhone) {
      try { body.contactPhone = normaliseGhanaPhone(String(body.contactPhone)); }
      catch (e) {
        if (e instanceof InvalidPhoneError) errors.contactPhone = [e.message]; else throw e;
      }
    }
    if (Object.keys(errors).length) throw new ValidationError(errors);

    const row = await this.users.addAddress(c.sub, {
      label: body.label, latitude: lat, longitude: lng,
      ghanapostAddress: body.ghanapostAddress ?? null,
      areaName: body.areaName ?? null,
      landmark: body.landmark ?? null,
      deliveryInstructions: body.deliveryInstructions ?? null,
      contactPhone: body.contactPhone ?? null,
      isDefault: body.isDefault === true,
    });
    return addressDto(row);
  }

  @Post('me/addresses/:id/default')
  async makeDefault(@Param('id') id: string, @Headers('authorization') auth?: string) {
    const c = this.me(auth);
    return addressDto(await this.users.setDefaultAddress(c.sub, id));
  }

  @Delete('me/addresses/:id')
  async removeAddress(@Param('id') id: string, @Headers('authorization') auth?: string) {
    const c = this.me(auth);
    await this.users.deleteAddress(c.sub, id);
    return { deleted: true };
  }
}

/* ------------------------------------------------------------------ */
/* Module                                                              */
/* ------------------------------------------------------------------ */

export interface IdentityDeps {
  pool?: Pool | null;
  sms?: SmsProvider;
  counters?: CounterStore;
  sessions?: SessionStore;
  users?: UserRepository;
  accessSecret?: string;
  refreshSecret?: string;
  exposeCodeForTests?: boolean;
  /**
   * Override the five rate-limit axes.
   *
   * Exists for integration tests, which sign in a dozen users from ONE IP
   * and would otherwise trip the 20/hour per-IP ceiling — a limit that is
   * correct in production and must not be weakened there.
   */
  otpLimits?: OtpLimits;
  storeLookup?: StoreLookup;
}

@Module({})
export class IdentityHttpModule {
  static forRoot(deps: IdentityDeps = {}): DynamicModule {
    const pool = deps.pool ?? null;
    const sms = deps.sms ?? new InMemorySmsProvider();
    const counters = deps.counters ?? new InMemoryCounterStore();
    const sessions = deps.sessions ?? (pool ? new PgSessionStore(pool) : new InMemorySessionStore());
    const users = deps.users ?? (pool ? new PgUserRepository(pool) : new InMemoryUserRepository());

    const otp = new OtpService(counters, sms, deps.otpLimits, {
      ...(deps.exposeCodeForTests ? { exposeCodeForTests: true } : {}),
    });
    const tokens = new TokenService(
      {
        ...DEFAULT_TOKEN_CONFIG,
        accessSecret: deps.accessSecret ?? 'dev-access-secret',
        refreshSecret: deps.refreshSecret ?? 'dev-refresh-secret',
      },
      sessions,
    );

    return {
      module: IdentityHttpModule,
      imports: [HealthModule.forRoot(pool)],
      controllers: [AuthController, UserController],
      providers: [
        { provide: OTP_SERVICE, useValue: otp },
        { provide: TOKEN_SERVICE, useValue: tokens },
        { provide: USER_REPOSITORY, useValue: users },
        {
          provide: STORE_LOOKUP,
          // Without a lookup nobody gets a vendorId, which is correct for a
          // customer-only deployment and obvious in the vendor app.
          useValue: deps.storeLookup ?? { storeIdFor: async () => null },
        },
      ],
    };
  }
}
