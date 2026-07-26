/**
 * Typed environment configuration.
 *
 * One rule: a service **fails to boot** if a credential it needs is missing
 * or obviously wrong. The alternative — discovering at 9pm on a Friday that
 * OTP has been silently falling back to a console logger since the last
 * deploy — is how a launch goes wrong quietly.
 *
 * Everything is read once at startup so a typo surfaces in the deploy logs,
 * not on a customer's first order.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type Env = Record<string, string | undefined>;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export function required(key: string, env: Env = process.env): string {
  const v = env[key]?.trim();
  if (!v) throw new ConfigError(`Missing required environment variable ${key}`);
  return v;
}

export function optional(key: string, fallback: string, env: Env = process.env): string {
  const v = env[key]?.trim();
  return v && v.length > 0 ? v : fallback;
}

export function optionalOrNull(key: string, env: Env = process.env): string | null {
  const v = env[key]?.trim();
  return v && v.length > 0 ? v : null;
}

export function numberFrom(key: string, fallback: number, env: Env = process.env): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  return n;
}

export function boolFrom(key: string, fallback: boolean, env: Env = process.env): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be a boolean, got "${raw}"`);
}

export type Stage = 'development' | 'staging' | 'production';

export function stageFrom(env: Env = process.env): Stage {
  const raw = optional('NODE_ENV', 'development', env);
  if (raw === 'production' || raw === 'staging' || raw === 'development') return raw;
  // 'test' and anything else behave as development.
  return 'development';
}

export const isProduction = (env: Env = process.env) => stageFrom(env) === 'production';

/* ------------------------------------------------------------------ */
/* Secrets                                                             */
/* ------------------------------------------------------------------ */

/** Placeholders that must never reach production. */
const FORBIDDEN_IN_PROD = [
  'dev-only-change-me', 'changeme', 'change-me', 'secret', 'password',
  'dev-access-secret', 'dev-refresh-secret', 'test', 'besonc_dev',
];

/**
 * A secret, with production guardrails.
 *
 * In development a weak default keeps `npm run dev` friction-free. In
 * production the same value is a hard boot failure — a JWT signed with
 * "dev-only-change-me" is a forgeable admin token.
 */
export function secret(
  key: string,
  opts: { devFallback?: string; minLength?: number } = {},
  env: Env = process.env,
): string {
  const prod = isProduction(env);
  const raw = env[key]?.trim();

  if (!raw) {
    if (prod || opts.devFallback === undefined) {
      throw new ConfigError(
        `Missing required secret ${key}`
        + (prod ? ' — this MUST be set in production' : ''),
      );
    }
    return opts.devFallback;
  }

  if (prod) {
    if (FORBIDDEN_IN_PROD.includes(raw.toLowerCase())) {
      throw new ConfigError(
        `${key} is set to the placeholder "${raw}" — refusing to start in production`,
      );
    }
    const min = opts.minLength ?? 32;
    if (raw.length < min) {
      throw new ConfigError(
        `${key} must be at least ${min} characters in production (got ${raw.length})`,
      );
    }
  }
  return raw;
}

/** Redact a secret for logging. Never log the raw value. */
export function redact(value: string | null | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

/* ------------------------------------------------------------------ */
/* Provider blocks                                                     */
/* ------------------------------------------------------------------ */

export interface HubtelEnv {
  clientId: string;
  clientSecret: string;
  senderId: string;
  baseUrl?: string;
}

/**
 * Hubtel SMS. Returns null when unconfigured, so development can run on the
 * in-memory provider — but see `smsConfigFrom`, which refuses that in
 * production.
 */
export function hubtelFrom(env: Env = process.env): HubtelEnv | null {
  const clientId = optionalOrNull('HUBTEL_CLIENT_ID', env);
  const clientSecret = optionalOrNull('HUBTEL_CLIENT_SECRET', env);
  const senderId = optionalOrNull('HUBTEL_SENDER_ID', env);

  if (!clientId && !clientSecret && !senderId) return null;

  // A half-configured provider is worse than none: it looks configured and
  // fails on the first real OTP.
  if (!clientId || !clientSecret || !senderId) {
    throw new ConfigError(
      'Hubtel is partially configured — HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET '
      + 'and HUBTEL_SENDER_ID must all be set together',
    );
  }
  // Hubtel sender IDs are max 11 chars (GSM alphanumeric originator limit)
  // and must be pre-approved. Catching this here beats silent delivery
  // failures that look like "the SMS just never arrives".
  if (senderId.length > 11) {
    throw new ConfigError(
      `HUBTEL_SENDER_ID "${senderId}" is ${senderId.length} characters; `
      + 'the GSM limit is 11',
    );
  }

  const baseUrl = optionalOrNull('HUBTEL_BASE_URL', env);
  return { clientId, clientSecret, senderId, ...(baseUrl ? { baseUrl } : {}) };
}

export interface ArkeselEnv { apiKey: string; senderId: string }

export function arkeselFrom(env: Env = process.env): ArkeselEnv | null {
  const apiKey = optionalOrNull('ARKESEL_API_KEY', env);
  const senderId = optionalOrNull('ARKESEL_SENDER_ID', env);
  if (!apiKey) return null;
  if (!senderId) {
    throw new ConfigError('ARKESEL_API_KEY is set but ARKESEL_SENDER_ID is missing');
  }
  return { apiKey, senderId };
}

export interface SmsConfig {
  hubtel: HubtelEnv | null;
  arkesel: ArkeselEnv | null;
  /** True when neither provider is configured and we fall back to in-memory. */
  usingStub: boolean;
}

export function smsConfigFrom(env: Env = process.env): SmsConfig {
  const hubtel = hubtelFrom(env);
  const arkesel = arkeselFrom(env);
  const usingStub = !hubtel && !arkesel;

  if (usingStub && isProduction(env)) {
    throw new ConfigError(
      'No SMS provider configured. Production cannot send OTPs, so nobody '
      + 'could sign in. Set HUBTEL_CLIENT_ID / HUBTEL_CLIENT_SECRET / HUBTEL_SENDER_ID.',
    );
  }
  return { hubtel, arkesel, usingStub };
}

export interface PaystackEnv {
  secretKey: string;
  publicKey: string | null;
  webhookSecret: string;
  /** True for sk_test_… keys — the app shows a "TEST MODE" banner. */
  isTestMode: boolean;
}

export function paystackFrom(env: Env = process.env): PaystackEnv | null {
  const secretKey = optionalOrNull('PAYSTACK_SECRET_KEY', env);
  if (!secretKey) {
    if (isProduction(env)) {
      throw new ConfigError('PAYSTACK_SECRET_KEY is required in production');
    }
    return null;
  }
  if (!/^sk_(test|live)_/.test(secretKey)) {
    throw new ConfigError(
      'PAYSTACK_SECRET_KEY must start with sk_test_ or sk_live_ '
      + '— it looks like a public key or a truncated value',
    );
  }

  const isTestMode = secretKey.startsWith('sk_test_');
  if (isProduction(env) && isTestMode) {
    throw new ConfigError(
      'PAYSTACK_SECRET_KEY is a TEST key but NODE_ENV=production. '
      + 'Real customers would be charged against a test account.',
    );
  }

  // Paystack signs webhooks with the secret key itself unless a separate
  // signing secret is configured. Defaulting keeps signatures verifiable.
  const webhookSecret = optionalOrNull('PAYSTACK_WEBHOOK_SECRET', env) ?? secretKey;
  return {
    secretKey,
    publicKey: optionalOrNull('PAYSTACK_PUBLIC_KEY', env),
    webhookSecret,
    isTestMode,
  };
}

export interface S3Env {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  forcePathStyle: boolean | undefined;
  publicBaseUrl: string | null;
}

/**
 * Object storage.
 *
 * Returns null in development, where media-svc falls back to in-memory
 * storage and DISCARDS every upload. That is fine for a laptop and
 * catastrophic in production: a delivery dispute with no proof photo is
 * unarguable, and KYC we cannot produce on request is a regulatory problem.
 * Hence the hard failure below.
 */
export function s3From(env: Env = process.env): S3Env | null {
  const endpoint = optionalOrNull('S3_ENDPOINT', env);
  if (!endpoint) {
    if (isProduction(env)) {
      throw new ConfigError(
        'S3_ENDPOINT is required in production. Without object storage, '
        + 'proof-of-delivery photos and KYC documents are silently discarded.',
      );
    }
    return null;
  }

  const accessKeyId = optionalOrNull('S3_ACCESS_KEY', env);
  const secretAccessKey = optionalOrNull('S3_SECRET_KEY', env);
  if (!accessKeyId || !secretAccessKey) {
    throw new ConfigError(
      'S3_ENDPOINT is set but S3_ACCESS_KEY / S3_SECRET_KEY are not. '
      + 'A half-configured bucket fails at the first rider upload, not at boot.',
    );
  }

  try { new URL(endpoint); }
  catch { throw new ConfigError(`S3_ENDPOINT is not a valid URL: ${endpoint}`); }

  if (isProduction(env) && endpoint.startsWith('http://')) {
    throw new ConfigError(
      'S3_ENDPOINT must use https in production — presigned URLs carry the '
      + 'signature in the query string and would travel in clear text.',
    );
  }

  const rawPathStyle = optionalOrNull('S3_FORCE_PATH_STYLE', env);
  return {
    endpoint,
    bucket: optional('S3_BUCKET', 'besonc-media', env),
    accessKeyId,
    secretAccessKey,
    region: optional('S3_REGION', 'auto', env),
    forcePathStyle: rawPathStyle === null ? undefined : /^(1|true|yes)$/i.test(rawPathStyle),
    publicBaseUrl: optionalOrNull('S3_PUBLIC_BASE_URL', env),
  };
}

export interface FirebaseEnv {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/**
 * Firebase Cloud Messaging.
 *
 * Absent, messaging-svc falls back to SMS for critical notifications — which
 * works, but costs money per message and is the reason this is only a
 * WARNING in production rather than a hard failure: no push is degraded,
 * not broken.
 *
 * The parsing lives in the FCM adapter; this only decides whether we have
 * something to parse, so a bad key fails at boot rather than at the first
 * "your rider has arrived".
 */
export function firebaseFrom(env: Env = process.env): FirebaseEnv | null {
  const raw = optionalOrNull('FIREBASE_SERVICE_ACCOUNT_JSON', env);
  if (!raw) return null;

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    try { json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); }
    catch {
      throw new ConfigError(
        'FIREBASE_SERVICE_ACCOUNT_JSON is neither JSON nor base64-encoded JSON. '
        + 'Paste the whole downloaded service-account file, or base64 it.',
      );
    }
  }

  for (const f of ['project_id', 'client_email', 'private_key']) {
    if (!json[f]) throw new ConfigError(`FIREBASE_SERVICE_ACCOUNT_JSON is missing "${f}"`);
  }

  const privateKey = String(json.private_key).replace(/\\n/g, '\n');
  if (!privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new ConfigError(
      'The Firebase private_key is not a PEM key. Pasted through a shell, its '
      + '\\n escapes are often mangled — RS256 then fails with an opaque '
      + 'OpenSSL error that looks like a revoked key.',
    );
  }

  return {
    projectId: String(json.project_id),
    clientEmail: String(json.client_email),
    privateKey,
    tokenUri: String(json.token_uri ?? 'https://oauth2.googleapis.com/token'),
  };
}

export interface MapsEnv { serverKey: string }

export function mapsFrom(env: Env = process.env): MapsEnv | null {
  const serverKey = optionalOrNull('GOOGLE_MAPS_SERVER_KEY', env);
  if (!serverKey) {
    if (isProduction(env)) {
      throw new ConfigError('GOOGLE_MAPS_SERVER_KEY is required in production');
    }
    return null;
  }
  return { serverKey };
}

/* ------------------------------------------------------------------ */
/* Infrastructure                                                      */
/* ------------------------------------------------------------------ */

export interface InfraConfig {
  databaseUrl: string | null;
  redisUrl: string | null;
  amqpUrl: string | null;
}

export function infraFrom(env: Env = process.env): InfraConfig {
  return {
    databaseUrl: optionalOrNull('DATABASE_URL', env),
    redisUrl: optionalOrNull('REDIS_URL', env),
    amqpUrl: optionalOrNull('RABBITMQ_URL', env),
  };
}

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

export function jwtFrom(env: Env = process.env): JwtConfig {
  const access = secret('JWT_ACCESS_SECRET', { devFallback: 'dev-access-secret' }, env);
  const refresh = secret('JWT_REFRESH_SECRET', { devFallback: 'dev-refresh-secret' }, env);

  // Reusing one secret for both means a stolen access token can be replayed
  // as a refresh token, defeating rotation entirely.
  if (access === refresh && isProduction(env)) {
    throw new ConfigError(
      'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ — '
      + 'sharing them defeats refresh-token rotation',
    );
  }

  return {
    accessSecret: access,
    refreshSecret: refresh,
    accessTtlSeconds: numberFrom('JWT_ACCESS_TTL_SECONDS', 15 * 60, env),
    refreshTtlSeconds: numberFrom('JWT_REFRESH_TTL_SECONDS', 30 * 24 * 3600, env),
  };
}

/* ------------------------------------------------------------------ */
/* Startup banner                                                      */
/* ------------------------------------------------------------------ */

/**
 * What this process will actually do, printed at boot.
 *
 * Deliberately loud about stubs: "SMS: IN-MEMORY STUB" in a staging log is
 * the difference between a five-minute fix and a day of debugging why the
 * test phone never receives a code.
 */
export function describeConfig(name: string, env: Env = process.env): string[] {
  const lines: string[] = [`[${name}] stage=${stageFrom(env)}`];
  const infra = infraFrom(env);

  lines.push(`[${name}] postgres=${infra.databaseUrl ? 'configured' : 'NOT CONFIGURED'}`);
  lines.push(`[${name}] redis=${infra.redisUrl ? 'configured' : 'NOT CONFIGURED'}`);
  lines.push(`[${name}] rabbitmq=${infra.amqpUrl ? 'configured' : 'NOT CONFIGURED'}`);

  try {
    const sms = smsConfigFrom(env);
    lines.push(
      `[${name}] sms=${sms.hubtel ? `hubtel(sender=${sms.hubtel.senderId})` : ''}`
      + `${sms.arkesel ? '+arkesel-failover' : ''}`
      + `${sms.usingStub ? 'IN-MEMORY STUB — no real messages will be sent' : ''}`,
    );
  } catch (e) {
    lines.push(`[${name}] sms=MISCONFIGURED: ${(e as Error).message}`);
  }

  try {
    const ps = paystackFrom(env);
    lines.push(
      `[${name}] paystack=${ps ? (ps.isTestMode ? 'TEST MODE' : 'LIVE') : 'NOT CONFIGURED'}`,
    );
  } catch (e) {
    lines.push(`[${name}] paystack=MISCONFIGURED: ${(e as Error).message}`);
  }

  const maps = optionalOrNull('GOOGLE_MAPS_SERVER_KEY', env);
  lines.push(`[${name}] maps=${maps ? redact(maps) : 'NOT CONFIGURED (haversine fallback)'}`);

  try {
    const fb = firebaseFrom(env);
    lines.push(
      `[${name}] push=${fb
        ? `fcm(${fb.projectId})`
        : 'NOT CONFIGURED — critical alerts fall back to SMS, which costs per message'}`,
    );
  } catch (e) {
    lines.push(`[${name}] push=MISCONFIGURED: ${(e as Error).message}`);
  }

  try {
    const s3 = s3From(env);
    lines.push(
      `[${name}] storage=${s3
        ? `s3(${new URL(s3.endpoint).host}/${s3.bucket})`
        : 'IN-MEMORY — uploads are DISCARDED, no proof of delivery survives'}`,
    );
  } catch (e) {
    lines.push(`[${name}] storage=MISCONFIGURED: ${(e as Error).message}`);
  }

  return lines;
}
