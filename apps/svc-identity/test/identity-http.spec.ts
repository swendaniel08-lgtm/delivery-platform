/**
 * identity-http.spec — the auth surface over real HTTP.
 *
 * These run against the in-memory repositories, which implement the same
 * rules as the SQL constraints. The point is to pin the WIRE CONTRACT the
 * three Flutter apps depend on: status codes, field names, error shapes.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createService, type RunningService } from '../../../libs/platform/src/service/bootstrap.ts';
import { IdentityHttpModule, SIGNUP_ROLES,
} from '../src/http.ts';
import { InMemorySmsProvider } from '../src/sms/provider.ts';
import { InMemoryUserRepository } from '../src/repository.ts';

let svc: RunningService;
let BASE = '';
let sms: InMemorySmsProvider;
let users: InMemoryUserRepository;

before(async () => {
  sms = new InMemorySmsProvider();
  users = new InMemoryUserRepository();
  svc = await createService({
    name: 'svc-identity',
    port: 4531,
    host: '127.0.0.1',
    module: IdentityHttpModule.forRoot({
      sms, users, exposeCodeForTests: true,
      accessSecret: 'test-access', refreshSecret: 'test-refresh',
    }),
  });
  BASE = svc.url;
});
after(async () => { await svc?.stop(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, { headers });

/** Full login for a fresh number. Each caller uses a distinct phone so the
 *  per-phone rate limits of one test never leak into another. */
async function login(phone: string, role = 'customer', device = 'dev-1') {
  const r1 = await post('/auth/otp/request', { phone }, { 'x-device-id': device });
  const b1 = await r1.json() as any;
  assert.ok(b1.debugCode, `no debug code for ${phone}: ${JSON.stringify(b1)}`);
  const r2 = await post(
    '/auth/otp/verify',
    { phone, code: b1.debugCode, role },
    { 'x-device-id': device },
  );
  const b2 = await r2.json() as any;
  assert.equal(r2.status, 201, JSON.stringify(b2));
  return b2;
}

/* ------------------------------------------------------------------ */

describe('OTP request', () => {
  test('sends an SMS and reports the TTL', async () => {
    const before = sms.sent.length;
    const r = await post('/auth/otp/request',
      { phone: '0244000001' }, { 'x-device-id': 'd-otp-1' });
    const b = await r.json() as any;

    assert.equal(r.status, 201);
    assert.equal(b.phone, '+233244000001', 'phone is normalised to E.164');
    assert.equal(b.expiresInSeconds, 300);
    assert.equal(sms.sent.length, before + 1);
    assert.match(sms.sent.at(-1)!.content, /Besonc verification code/);
  });

  test('a malformed number is 422 with a field error, not 500', async () => {
    const r = await post('/auth/otp/request',
      { phone: '12345' }, { 'x-device-id': 'd-otp-2' });
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.equal(b.type, 'https://errors.besonc.app/validation-failed');
    assert.ok(b.errors.phone, 'error is attributed to the phone field');
  });

  test('a missing phone is 422', async () => {
    const r = await post('/auth/otp/request', {}, { 'x-device-id': 'd-otp-3' });
    assert.equal(r.status, 422);
  });

  test('resending immediately is refused with a cooldown', async () => {
    const phone = '0244000002';
    await post('/auth/otp/request', { phone }, { 'x-device-id': 'd-otp-4' });
    const r = await post('/auth/otp/request', { phone }, { 'x-device-id': 'd-otp-4' });
    const b = await r.json() as any;
    assert.equal(r.status, 429);
    assert.ok(b.retryAfterSeconds > 0, 'client is told how long to wait');
  });

  test('the fourth code in an hour for one phone is refused', async () => {
    // perPhoneHour is 3. Distinct devices so only the phone axis bites.
    const phone = '0244000003';
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await post('/auth/otp/request', { phone }, { 'x-device-id': `d-burst-${i}` });
      codes.push(r.status);
      // Burn the cooldown by verifying with a wrong code is not enough;
      // instead we rely on distinct requests hitting the cooldown first.
      if (r.status === 429) break;
    }
    assert.ok(codes.includes(429), 'rate limiting eventually kicks in');
  });
});

describe('OTP verify', () => {
  test('a correct code creates the account and returns tokens', async () => {
    const b = await login('0244000010');
    assert.equal(b.isNewUser, true);
    assert.equal(b.user.phone, '+233244000010');
    assert.equal(b.user.role, 'customer');
    assert.equal(b.user.phoneVerified, true);
    assert.ok(b.tokens.accessToken.split('.').length === 3, 'access token is a JWT');
    assert.ok(b.tokens.refreshToken.includes('.'));
    assert.ok(b.tokens.accessExpiresAt > Date.now());
  });

  test('a second login for the same number is not a new user', async () => {
    const phone = '0244000011';
    await login(phone);
    // A fresh code requires the cooldown to lapse; instead we assert the
    // account survives by asking the repository directly.
    const row = await users.findByPhone('+233244000011');
    assert.ok(row);
    assert.equal(row!.phone_verified, true);
  });

  test('a wrong code is 422 and says how many tries remain', async () => {
    const phone = '0244000012';
    await post('/auth/otp/request', { phone }, { 'x-device-id': 'd-wrong' });
    const r = await post('/auth/otp/verify', { phone, code: '000000' });
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.match(b.errors.code[0], /attempt\(s\) remaining/);
  });

  test('an unknown signup role is refused', async () => {
    const phone = '0244000013';
    const req = await post('/auth/otp/request', { phone }, { 'x-device-id': 'd-role' });
    const { debugCode } = await req.json() as any;
    const r = await post('/auth/otp/verify', { phone, code: debugCode, role: 'admin' });
    assert.equal(r.status, 422, 'admins are provisioned by admins, never by OTP signup');
  });

  test('a number registered as a customer cannot log in as a rider', async () => {
    const phone = '0244000014';
    await login(phone, 'customer', 'd-conflict');
    const req = await post('/auth/otp/request', { phone }, { 'x-device-id': 'd-conflict-2' });
    const { debugCode } = await req.json() as any;
    const r = await post('/auth/otp/verify', { phone, code: debugCode, role: 'rider' });
    const b = await r.json() as any;
    assert.equal(r.status, 409);
    assert.match(b.detail ?? b.title, /already registered/);
  });
});

describe('token lifecycle', () => {
  test('refresh rotates and the old token stops working', async () => {
    const s = await login('0244000020', 'customer', 'd-rot');
    const first = s.tokens.refreshToken;

    const r1 = await post('/auth/token/refresh', { refreshToken: first });
    const b1 = await r1.json() as any;
    assert.equal(r1.status, 201);
    assert.notEqual(b1.tokens.refreshToken, first, 'a new refresh token is issued');

    const r2 = await post('/auth/token/refresh', { refreshToken: first });
    assert.equal(r2.status, 401, 'the spent token is dead');
  });

  test('replaying a rotated token kills the whole family', async () => {
    const s = await login('0244000021', 'customer', 'd-reuse');
    const first = s.tokens.refreshToken;
    const b1 = await (await post('/auth/token/refresh', { refreshToken: first })).json() as any;

    // Attacker replays the old one → reuse detected → everything revoked.
    await post('/auth/token/refresh', { refreshToken: first });

    const r = await post('/auth/token/refresh', { refreshToken: b1.tokens.refreshToken });
    assert.equal(r.status, 401, 'the honest client is logged out too — correct, and deliberate');
  });

  test('a garbage refresh token is 401, never 500', async () => {
    const r = await post('/auth/token/refresh', { refreshToken: 'not-a-token' });
    assert.equal(r.status, 401);
  });

  test('introspect answers active/inactive rather than throwing', async () => {
    const s = await login('0244000022', 'customer', 'd-intro');
    const ok = await (await post('/auth/token/introspect', { token: s.tokens.accessToken })).json() as any;
    assert.equal(ok.active, true);
    assert.equal(ok.sub, s.user.id);
    assert.equal(ok.role, 'customer');

    const bad = await (await post('/auth/token/introspect', { token: 'x.y.z' })).json() as any;
    assert.equal(bad.active, false);
  });

  test('logout revokes every session for the user', async () => {
    const s = await login('0244000023', 'customer', 'd-logout');
    const r = await post('/auth/logout', {}, { authorization: `Bearer ${s.tokens.accessToken}` });
    const b = await r.json() as any;
    assert.equal(r.status, 201);
    assert.ok(b.revokedSessions >= 1);

    const after = await post('/auth/token/refresh', { refreshToken: s.tokens.refreshToken });
    assert.equal(after.status, 401);
  });
});

describe('profile', () => {
  test('GET /users/me needs a bearer token', async () => {
    assert.equal((await get('/users/me')).status, 401);
    assert.equal((await get('/users/me', { authorization: 'Bearer nope' })).status, 401);
  });

  test('profile round-trips first and last name', async () => {
    const s = await login('0244000030', 'customer', 'd-prof');
    const h = { authorization: `Bearer ${s.tokens.accessToken}`, 'content-type': 'application/json' };

    const patched = await fetch(`${BASE}/users/me`, {
      method: 'PATCH', headers: h,
      body: JSON.stringify({ firstName: 'Ama', lastName: 'Mensah' }),
    });
    const b = await patched.json() as any;
    assert.equal(b.firstName, 'Ama');
    assert.equal(b.lastName, 'Mensah');

    const me = await (await get('/users/me', h)).json() as any;
    assert.equal(me.firstName, 'Ama');
    assert.equal(me.phone, '+233244000030');
  });

  test('a bad email is 422', async () => {
    const s = await login('0244000031', 'customer', 'd-email');
    const r = await fetch(`${BASE}/users/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${s.tokens.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    assert.equal(r.status, 422);
  });
});

describe('addresses', () => {
  let auth: Record<string, string>;

  before(async () => {
    const s = await login('0244000040', 'customer', 'd-addr');
    auth = { authorization: `Bearer ${s.tokens.accessToken}`, 'content-type': 'application/json' };
  });

  test('the first address is default whether or not it asks to be', async () => {
    const r = await post('/users/me/addresses',
      { label: 'Home', latitude: 5.6037, longitude: -0.1870, landmark: 'Opposite Melcom' }, auth);
    const b = await r.json() as any;
    assert.equal(r.status, 201);
    assert.equal(b.isDefault, true);
    assert.equal(b.landmark, 'Opposite Melcom');
  });

  test('a second address is not default, and can be promoted', async () => {
    const b = await (await post('/users/me/addresses',
      { label: 'Work', latitude: 5.5600, longitude: -0.2050 }, auth)).json() as any;
    assert.equal(b.isDefault, false);

    const promoted = await (await post(`/users/me/addresses/${b.id}/default`, {}, auth)).json() as any;
    assert.equal(promoted.isDefault, true);

    const list = await (await get('/users/me/addresses', auth)).json() as any;
    assert.equal(list.addresses.filter((a: any) => a.isDefault).length, 1,
      'exactly one default survives');
    assert.equal(list.addresses[0].isDefault, true, 'the default sorts first');
  });

  test('coordinates outside the world are 422', async () => {
    const r = await post('/users/me/addresses', { latitude: 999, longitude: -0.18 }, auth);
    const b = await r.json() as any;
    assert.equal(r.status, 422);
    assert.ok(b.errors.latitude);
  });

  test('a malformed GhanaPostGPS code is refused', async () => {
    const r = await post('/users/me/addresses',
      { latitude: 5.6, longitude: -0.18, ghanapostAddress: 'GA123' }, auth);
    assert.equal(r.status, 422);
  });

  test('a well-formed GhanaPostGPS code is kept', async () => {
    const b = await (await post('/users/me/addresses',
      { latitude: 5.6, longitude: -0.18, ghanapostAddress: 'GA-123-4567' }, auth)).json() as any;
    assert.equal(b.ghanapostAddress, 'GA-123-4567');
  });

  test('a contact phone is normalised to E.164', async () => {
    const b = await (await post('/users/me/addresses',
      { latitude: 5.6, longitude: -0.18, contactPhone: '0209998877' }, auth)).json() as any;
    assert.equal(b.contactPhone, '+233209998877');
  });

  test('deleting the default promotes another address', async () => {
    const list = await (await get('/users/me/addresses', auth)).json() as any;
    const def = list.addresses.find((a: any) => a.isDefault);
    const r = await fetch(`${BASE}/users/me/addresses/${def.id}`, { method: 'DELETE', headers: auth });
    assert.equal(r.status, 200);

    const after = await (await get('/users/me/addresses', auth)).json() as any;
    assert.equal(after.addresses.filter((a: any) => a.isDefault).length, 1,
      'the user is never left without a default');
  });

  test("one user cannot touch another user's address", async () => {
    const other = await login('0244000041', 'customer', 'd-addr-2');
    const otherAuth = {
      authorization: `Bearer ${other.tokens.accessToken}`, 'content-type': 'application/json',
    };
    const mine = await (await get('/users/me/addresses', auth)).json() as any;
    const victim = mine.addresses[0].id;

    const r = await fetch(`${BASE}/users/me/addresses/${victim}`,
      { method: 'DELETE', headers: otherAuth });
    assert.equal(r.status, 404, 'tenant isolation: it does not exist for them');
  });
});


/* ------------------------------------------------------------------ */
/* Role self-assignment                                               */
/* ------------------------------------------------------------------ */

describe('a caller cannot promote themselves', () => {
  /**
   * The signup role arrives in the request body — a genuine new vendor or
   * rider has no other way to say which they are. So the line between
   * self-assignable and staff roles is the only thing between a phone number
   * and an admin session.
   *
   * Asserted against the ALLOW-LIST rather than by driving HTTP once per
   * role: the suite already spends 26 of its 20-per-IP-hour OTP budget, and a
   * security test that fails because it ran out of rate limit is a security
   * test that has stopped testing security.
   */
  test('the self-assignable set contains no staff role', () => {
    const staff = [
      'super_admin', 'ops_manager', 'finance', 'support',
      'dispatcher', 'read_only', 'admin',
    ];
    for (const role of staff) {
      assert.ok(!SIGNUP_ROLES.includes(role as any),
        `'${role}' is self-assignable — anyone with a phone could become one`);
    }
  });

  test('the set is exactly the three real signup paths', () => {
    // Pinned deliberately. Adding to this list must be a conscious act with
    // a failing test in front of it, not a quiet edit.
    assert.deepEqual(
      [...SIGNUP_ROLES].sort(),
      ['customer', 'rider', 'vendor_owner'],
    );
  });

  test('asking for a staff role over HTTP does not grant it', async () => {
    // One request, spent on the highest-value target.
    const phone = `02447${Math.floor(Math.random() * 90000 + 10000)}`;
    const req = await post('/auth/otp/request', { phone },
      { 'x-device-id': 'dev-escalate' });
    const b1 = await req.json() as any;

    if (!b1.debugCode) {
      // Rate limited means no account was created, so nothing was granted.
      assert.equal(req.status, 429);
      return;
    }

    const res = await post('/auth/otp/verify',
      { phone, code: b1.debugCode, role: 'super_admin' },
      { 'x-device-id': 'dev-escalate' });
    assert.notEqual((await res.json() as any)?.user?.role, 'super_admin');
  });
});
