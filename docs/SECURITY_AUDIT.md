# Security audit — findings

**Method:** every finding below was proven by writing the attack and running it
against a live service, not by reading code. Every fix is mutation-tested:
reinstating the old check turns the new specs red.

This matters because all four holes were in code that *reads* as though it
authorises. Three of them sat behind a function whose name implied a
permission check.

---

## Closed

### 1. Chat transcripts readable by any signed-in customer — CRITICAL

`canChat()` validated the party TYPE ("a customer may talk to a rider") and the
30-minute window. It never validated the party IDENTITY.

```
victim   POST /messaging/chat/victim-order-1  "Gate code is 4417, flat 2B"
attacker GET  /messaging/chat/victim-order-1  -> 200, full transcript
```

Any authenticated customer could read — and post into — any order's
conversation by guessing an id. Delivery chats are where people write gate
codes, flat numbers and "leave it with the guard, I'm out until six". This is
home access, not a privacy nit.

**Fix:** `OrderParticipantLookup` + `order_participants` projection;
`requireParticipant()` on both chat routes. Admins refused too — support
reading live customer conversations should be a separate audited capability.

**Also found:** `append()` wrote the party NAME into `from_user_id`, a uuid
column, so every genuine send 500'd. A transcript that cannot say which
*account* sent a message is not evidence.

### 2. Media objects — broken in both directions at once

```js
if (!decoded.includes(c.sub)) throw new ForbiddenError('Not your object');
```

- **Denied the owner.** `buildKey` embeds `ownerRef` (an ORDER id), not the
  uploader. The rider who took the proof photo got 403 reading it back.
- **Granted an attacker.** `ownerRef` is client-supplied. Upload once naming
  yourself, then read any key containing that substring.
  `proof_of_delivery/evil/forged.jpg` → 200.

**Fix:** ownership recorded in `media_objects` (which already had
`uploader_id` and was never written to) at URL-issue time.

### 3. Admin privilege escalation

`POST /admin/actions` required the caller to send `ability` and `subject`, then
checked permissions against them — letting the caller choose which permission
to verify.

```
read_only + {"action":"payment.refund","ability":"read","subject":"Report"}
-> 201, refund recorded
```

**Fix:** server-side `ACTION_PERMISSIONS` registry. Unregistered actions are
refused, not defaulted.

### 4. Prototype pollution in the permission lookup

Found while fuzzing fix #3. `ACTION_PERMISSIONS['constructor']` returns
`Object`; `['__proto__']` returns a prototype. Both truthy, so those names
passed the "known action?" gate and reached the ability check with
`ability: undefined`.

**Fix:** `Object.hasOwn` plus a shape assertion.

---

## Checked and clean

### Paystack webhook

Attacked with: no signature, forged signature, sha256 instead of sha512, and a
valid signature over a tampered body. All four → 401. Genuine → accepted.
Verification runs on the **raw body before parsing**, using `timingSafeEqual`.
**No change needed.**

### Gateway / service isolation

- Exactly one published port in compose — the gateway.
- `x-user-id` / `x-user-role` are set only by the gateway, after JWT
  verification. Services never read them from an external request.

### Tracking positions

`canWatchOrder()` does check identity, and returns 404 rather than 403 so a
stranger cannot confirm an order exists.

---

## The pattern

Three of four holes shared one shape: **the schema already anticipated the
check, and the code never used it.** `media_objects.uploader_id`,
`device_tokens.revoked_at`, `order_participants` — all designed, all unwritten.

The second pattern: **unit tests passed throughout**, because fixtures
pre-seeded the state production could never create. Only running the real
service found these.

---

---

## A test that could not fail

While fixing the OTP hashing I wrote this regression spec:

```ts
const dump = JSON.stringify([...(store as any).map ?? []]);
assert.ok(!dump.includes(debugCode), 'the code appears in clear');
```

The field is `data`, not `map`. It serialised `undefined`, compared against an
empty string, and passed regardless of what the service stored. Its entire
purpose was to catch OTP codes being written reversibly — and when I reverted
the fix to check, it stayed green.

**A test that cannot go red is worse than no test.** No test is a known gap. A
green one that cannot fail is a gap everyone believes is closed.

`infra/scripts/find-vacuous-assertions.ts` now flags the two shapes that cause
this: negative assertions on a subject never proven non-empty, and `as any`
reaching into private fields. It reports rather than gates — 18 current hits,
and the three highest-stakes ones were mutation-tested and are genuine:

| Assertion | Mutation | Result |
|---|---|---|
| "NEVER prints a raw secret" | make `redact()` return the input | went red |
| "the gate code leaked" | restore the chat vulnerability | went red |
| "A SOLD-OUT ITEM IS HIDDEN" | stop filtering `isAvailable` | went red |

The linter over-reports deliberately. The question it asks for each hit is the
only one that matters: *if the code under test were reverted, would this line
go red?* If you cannot answer, mutate it and find out.

---

### OTP codes stored reversibly — HIGH

`base64(phone:code)` — not a hash. Anyone reading the OTP store (backup,
misconfigured bind, support dump) recovered every live code and could sign in
as any user mid-flight. Labelled "placeholder"; nothing replaced it.

**Fix:** HMAC-SHA256 keyed with `OTP_PEPPER`, phone bound in, production
refuses to start without a pepper. See also the note below — my first
regression spec for this could not fail.

---

## Checked and clean (round 2)

### Vendor isolation

`vendorId` is looked up server-side from the authenticated user at login and
carried in the token; the vendor BFF reads it from the token and never from
the request. `assertOwnStore()` re-checks order ownership and 404s on
mismatch. **No change needed.**

### OTP brute force

Five wrong attempts burns the code; the correct code is then also refused,
so an attacker cannot exhaust guesses and still use a leaked code. Per-phone
(3/hr), per-device (5/hr), per-IP (20/hr) and global caps all enforced —
verified live, including that the cap fires during testing.

### Refresh token rotation

Textbook. One use per token; replaying a rotated token is detected as reuse
and revokes the **entire session family**, so a stolen token buys at most one
refresh and locks the real user out of nothing they cannot recover by signing
in again. Verified live: legitimate rotation works, replay 401s, and the
newly-issued token is dead too.

### Role self-assignment

Signup roles arrive in the body (a new vendor has no other way to declare
itself), so the allow-list is the boundary. `SIGNUP_ROLES` is exactly
`customer`, `vendor_owner`, `rider`. Asking for `super_admin` grants nothing.
Now pinned by a spec that fails if the list grows.

---

## Still to audit

- [ ] Rate limiting under real load (k6 not yet run)
- [ ] Dependency audit in CI
- [ ] COD remittance and the payout saga
- [ ] The 18 flagged assertions — 3 sampled and genuine, 15 untriaged
