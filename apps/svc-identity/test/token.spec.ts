/** token.spec — JWT issuance, rotation, and refresh-token reuse detection. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TokenService, InMemorySessionStore, DEFAULT_TOKEN_CONFIG, type Principal,
} from '../src/token/token-service.ts';
import { UnauthorizedError } from '../../../libs/platform/src/errors.ts';

function harness() {
  let now = 1_700_000_000_000;
  let n = 0;
  const store = new InMemorySessionStore();
  const svc = new TokenService(
    { accessSecret: 'access-secret', refreshSecret: 'refresh-secret', ...DEFAULT_TOKEN_CONFIG },
    store,
    () => now,
    () => `id-${++n}`,
  );
  return { svc, store, advance: (s: number) => (now += s * 1000), nowMs: () => now };
}

const rider: Principal = { userId: 'u-rider', role: 'rider' };
const finance: Principal = { userId: 'u-fin', role: 'admin', scope: 'finance' };

describe('issuance', () => {
  test('issues a verifiable access token with the right claims', async () => {
    const { svc } = harness();
    const pair = await svc.issue(rider, 'device-1');
    const claims = svc.verifyAccess(pair.accessToken);
    assert.equal(claims.sub, 'u-rider');
    assert.equal(claims.role, 'rider');
    assert.ok(claims.exp > claims.iat);
    assert.equal(claims.exp - claims.iat, 15 * 60);
  });

  test('carries admin scope and vendor/zone context', async () => {
    const { svc } = harness();
    const a = svc.verifyAccess((await svc.issue(finance)).accessToken);
    assert.equal(a.scope, 'finance');

    const v = svc.verifyAccess(
      (await svc.issue({ userId: 'u-v', role: 'vendor_owner', vendorId: 'v1' })).accessToken,
    );
    assert.equal(v.vendorId, 'v1');
  });

  test('access token expires', async () => {
    const { svc, advance } = harness();
    const pair = await svc.issue(rider);
    advance(15 * 60 + 1);
    assert.throws(() => svc.verifyAccess(pair.accessToken), UnauthorizedError);
  });
});

describe('tamper resistance', () => {
  test('rejects a modified payload', async () => {
    const { svc } = harness();
    const pair = await svc.issue(rider);
    const [h, b, s] = pair.accessToken.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    claims.role = 'admin'; // privilege escalation attempt
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    assert.throws(() => svc.verifyAccess(forged), UnauthorizedError);
  });

  test('rejects the alg=none attack', async () => {
    const { svc } = harness();
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      sub: 'u-attacker', role: 'admin', iat: 1, exp: 9_999_999_999, jti: 'x',
    })).toString('base64url');
    assert.throws(() => svc.verifyAccess(`${header}.${body}.`), UnauthorizedError);
  });

  test('rejects a token signed with the wrong secret', async () => {
    const { svc } = harness();
    const other = new TokenService(
      { accessSecret: 'WRONG', refreshSecret: 'r', ...DEFAULT_TOKEN_CONFIG },
      new InMemorySessionStore(),
    );
    const evil = await other.issue({ userId: 'u-attacker', role: 'admin' });
    assert.throws(() => svc.verifyAccess(evil.accessToken), UnauthorizedError);
  });

  test('rejects malformed tokens', () => {
    const { svc } = harness();
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '...']) {
      assert.throws(() => svc.verifyAccess(bad), UnauthorizedError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('refresh rotation', () => {
  test('rotation issues a new pair and spends the old token', async () => {
    const { svc } = harness();
    const first = await svc.issue(rider);
    const second = await svc.refresh(first.refreshToken, rider);
    assert.notEqual(second.refreshToken, first.refreshToken);
    assert.notEqual(second.sessionId, first.sessionId);
    // new one still works
    assert.equal(svc.verifyAccess(second.accessToken).sub, 'u-rider');
  });

  test('a spent refresh token cannot be reused', async () => {
    const { svc } = harness();
    const first = await svc.issue(rider);
    await svc.refresh(first.refreshToken, rider);
    await assert.rejects(() => svc.refresh(first.refreshToken, rider), UnauthorizedError);
  });

  test('REUSE DETECTION: replaying a spent token kills the whole family', async () => {
    const { svc, store } = harness();
    const t1 = await svc.issue(rider);
    const t2 = await svc.refresh(t1.refreshToken, rider);   // legitimate rotation
    const t3 = await svc.refresh(t2.refreshToken, rider);   // legitimate rotation

    // Attacker replays the stolen, already-spent t1
    await assert.rejects(() => svc.refresh(t1.refreshToken, rider), UnauthorizedError);

    // Every live session for that user is now revoked, including the
    // legitimate client's current one.
    await assert.rejects(() => svc.refresh(t3.refreshToken, rider), UnauthorizedError);
    assert.ok(store.revocations.some((r) => r.reason === 'refresh_token_reuse'));
  });

  test('refresh token cannot be used for a different user', async () => {
    const { svc } = harness();
    const pair = await svc.issue(rider);
    await assert.rejects(
      () => svc.refresh(pair.refreshToken, { userId: 'someone-else', role: 'rider' }),
      UnauthorizedError,
    );
  });

  test('expired refresh token is rejected', async () => {
    const { svc, advance } = harness();
    const pair = await svc.issue(rider);
    advance(31 * 24 * 3600);
    await assert.rejects(() => svc.refresh(pair.refreshToken, rider), UnauthorizedError);
  });

  test('unknown refresh token is rejected', async () => {
    const { svc } = harness();
    await assert.rejects(() => svc.refresh('made-up-token', rider), UnauthorizedError);
  });
});

describe('logout', () => {
  test('revokeAll invalidates every device', async () => {
    const { svc } = harness();
    const phone = await svc.issue(rider, 'phone');
    const tablet = await svc.issue(rider, 'tablet');
    const n = await svc.revokeAll('u-rider');
    assert.equal(n, 2);
    await assert.rejects(() => svc.refresh(phone.refreshToken, rider), UnauthorizedError);
    await assert.rejects(() => svc.refresh(tablet.refreshToken, rider), UnauthorizedError);
  });
});
