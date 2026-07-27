# Running Besonc locally

Everything below has been executed on this machine and works. If a step
fails for you, that is a bug — please say so rather than working around it.

---

## 1. Quick start (no credentials)

```bash
bash infra/scripts/bootstrap.sh      # Node, Docker, Compose, Flutter (~70s)
npm ci
bash infra/scripts/run-stack.sh
```

You should see:

```
  OK   identity       http://127.0.0.1:3001
  OK   catalogue      http://127.0.0.1:3002
  OK   pricing        http://127.0.0.1:3004
  OK   dispatch       http://127.0.0.1:3005
  OK   tracking       http://127.0.0.1:3006
  OK   payment        http://127.0.0.1:3007
  OK   bff-customer   http://127.0.0.1:3101
  OK   bff-vendor     http://127.0.0.1:3102
  OK   bff-rider      http://127.0.0.1:3103
  OK   gateway        http://127.0.0.1:3000

Stack is up. Public API: http://127.0.0.1:3000
```

Other commands:

```bash
bash infra/scripts/run-stack.sh status
bash infra/scripts/run-stack.sh logs identity
bash infra/scripts/run-stack.sh stop
```

Without a `.env` everything runs in **development mode**: SMS goes to an
in-memory stub, payments are disabled, storage is in memory. Each service
says so at startup — if you see `IN-MEMORY STUB`, no real message is being
sent anywhere.

---

## 2. Prove it works end to end

`EXPOSE_OTP_CODES=true` returns the OTP in the API response, so you can sign
in without a real SMS. It is ignored when `NODE_ENV=production`.

```bash
EXPOSE_OTP_CODES=true bash infra/scripts/run-stack.sh

# 1. Ask for a code
curl -s -X POST http://127.0.0.1:3000/api/auth/otp/request \
  -H 'content-type: application/json' \
  -d '{"phone":"0244123456"}'
# {"phone":"+233244123456","expiresInSeconds":300,"provider":"in-memory","debugCode":"082723"}

# 2. Exchange it for tokens
curl -s -X POST http://127.0.0.1:3000/api/auth/otp/verify \
  -H 'content-type: application/json' \
  -d '{"phone":"0244123456","code":"082723","role":"customer"}'
# {"isNewUser":true,"user":{...},"tokens":{"accessToken":"eyJ...","refreshToken":"..."}}

# 3. Call an authenticated screen
curl -s http://127.0.0.1:3000/api/customer/home \
  -H "authorization: Bearer eyJ..."
```

That path crosses the gateway, identity-svc, the customer BFF and its
upstreams — the whole chain.

---

## 3. Adding your credentials

```bash
cp .env.example .env
$EDITOR .env
bash infra/scripts/run-stack.sh   # picks .env up automatically
```

`.env` is gitignored. Never commit it.

### What each block unlocks

| Block | Without it | With it |
|---|---|---|
| `DATABASE_URL` | State is in memory, lost on restart | Real persistence |
| `REDIS_URL` | OTP limits are per-process; dispatch cannot arbitrate between replicas | Correct with >1 replica |
| `HUBTEL_*` | OTP codes are logged, never sent | Real SMS to real phones |
| `PAYSTACK_SECRET_KEY` | The webhook route is **not mounted** | Payments can be confirmed |
| `GOOGLE_MAPS_SERVER_KEY` | Straight-line × 1.4 (errs high, never undercharges) | Real routed, traffic-aware distances |

### What "real" means per integration

| Integration | Status |
|---|---|
| **Hubtel SMS** | Real client. OTP and notifications both send the moment the three vars are set. |
| **Paystack** | Real client. Checkout initiates a momo charge; the signed webhook confirms it. A 201 is *not* a payment. |
| **Google Maps** | Real client. Distance Matrix (traffic-aware), reverse geocoding, Ghana-restricted autocomplete. |
| **Firebase push** | Port defined, adapter not written. Notifications fall back to SMS. |
| **S3 / object storage** | Presigned-upload port defined; the S3 adapter is not written, so uploads are discarded in dev. |

Verify each is live from the startup banner:

```bash
bash infra/scripts/run-stack.sh logs identity     | grep sms=
bash infra/scripts/run-stack.sh logs payment      | grep -i paystack
bash infra/scripts/run-stack.sh logs bff-customer | grep distances=
```

You want to see `sms=hubtel(sender=…)`, `Paystack webhook mounted (LIVE mode)`
and `distances=google (routed)`. Anything saying STUB or *estimate* is not
talking to the outside world.

### Generating JWT secrets

```bash
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET   (must be DIFFERENT)
```

They must differ. Sharing one secret means a stolen access token can be
replayed as a refresh token, which defeats rotation entirely — the service
refuses to start in production if they match.

### Hubtel

```
HUBTEL_CLIENT_ID=...
HUBTEL_CLIENT_SECRET=...
HUBTEL_SENDER_ID=Besonc
```

All three or none — a half-configured provider looks fine until the first
real OTP. The sender ID must be **pre-approved by Hubtel** and is capped at
**11 characters** by the GSM standard; a longer one is rejected at startup
rather than silently never arriving.

Verify it is live:

```bash
bash infra/scripts/run-stack.sh logs identity | grep sms=
# [svc-identity] sms=hubtel(sender=Besonc)          <- real
# [svc-identity] sms=IN-MEMORY STUB ...             <- not sending
```

Then request a code to your own phone. If Hubtel fails and Arkesel is
configured, the failover logs each attempt:

```
[svc-identity] sms attempt provider=hubtel ok=false error=...
[svc-identity] sms attempt provider=arkesel ok=true
```

### Paystack

Start with **test** keys (`sk_test_…`). Point the Paystack dashboard webhook
at:

```
https://<your-host>/api/webhooks/paystack
```

Locally, expose port 3000 with a tunnel — Paystack cannot reach `localhost`.

Two guardrails worth knowing:

- A `sk_test_` key with `NODE_ENV=production` is **refused at startup**.
  Real customers would otherwise be charged against a test account.
- Pasting a `pk_` public key into `PAYSTACK_SECRET_KEY` is caught too.

The webhook is verified against the **literal bytes** Paystack sends. Do not
put anything in front of the gateway that reformats JSON bodies — that
silently breaks every signature.

---

## 4. Production guardrails

With `NODE_ENV=production`, services **refuse to start** rather than run
half-configured. Each of these is a real outage avoided:

| Refusal | Why |
|---|---|
| No SMS provider | Nobody could receive an OTP, so nobody could sign in at all |
| Placeholder secret (`dev-only-change-me`) | A JWT signed with a public placeholder is a forgeable admin token |
| Secret under 32 characters | Brute-forceable HMAC |
| `JWT_ACCESS_SECRET == JWT_REFRESH_SECRET` | Defeats refresh-token rotation |
| Paystack test key in production | Real customers charged against a test account |
| payment-svc with no `DATABASE_URL` | An in-memory ledger loses every settlement on restart, unrecoverably |
| dispatch-svc with no `REDIS_URL` | Replicas cannot arbitrate the accept race; two riders win the same order |

A configuration failure exits with code **78** (`EX_CONFIG`) and prints a
plain message, not a stack trace.

---

## 5. Pointing the apps at the backend

```bash
cd mobile/apps/customer
flutter run --dart-define=BESONC_API_URL=http://10.0.2.2:3000
```

`10.0.2.2` is how the Android emulator reaches your machine's localhost.
Using `localhost` there is the most common reason a first run shows
"No connection". On a physical phone use your machine's LAN IP.

---

## 6. Tests

```bash
bash infra/scripts/test-all.sh      # 684 TS unit specs, no containers
bash infra/scripts/test-db.sh       # integration; spins Postgres/Redis/RabbitMQ
bash infra/scripts/test-mobile.sh   # 353 Dart specs
```

---

## 7. Ports

| Port | Service |
|---|---|
| 3000 | gateway — **the only one that should be public** |
| 3001 | identity |
| 3002 | catalogue |
| 3003 | order |
| 3004 | pricing |
| 3005 | dispatch |
| 3006 | tracking |
| 3007 | payment |
| 3101–3104 | BFFs (customer, vendor, rider, admin) |

Only 3000 should ever be reachable from outside. The services trust
`x-user-id` and friends **because the gateway sets them** — it strips any
client-supplied copy first. Exposing a service port directly bypasses that
and lets anyone impersonate any user.

## Verifying credentials: `make verify`

Every provider client is real and wired to env vars. `make verify` answers the
only question that matters before a pilot: **is this credential actually
alive?**

```bash
cp .env.example .env      # fill in your keys
make verify
```

It makes the cheapest real call per provider that proves the credential works,
and prints the provider's own error text verbatim — that text is nearly always
the actual answer.

**Nobody needs to paste a key anywhere.** Every secret is redacted to
`sk_test_…4f2a`, so the output is safe to share in a ticket or a chat. Fill in
`.env` locally, run it, send the output.

| Provider | What it calls | Charges? |
|---|---|---|
| Paystack | `GET /balance` | No — read-only |
| Hubtel | `messages/send` with no recipient | **No message is sent**, nobody is billed |
| Google Maps | one Distance Matrix element, Osu→Accra Mall | One element, negligible |
| Firebase | mints an OAuth2 token | No — no notification is sent |
| S3/R2 | presigned PUT of a tiny file, then deletes it | Negligible |

Exit 0 means everything configured is working. Missing credentials are `SKIP`,
never a failure — a partial environment is a normal state.

### Two things it checks that are easy to get wrong

- **Paystack**: whether the account has a **GHS balance**. A perfectly valid
  key on an account that is not enabled for Ghana will pass authentication and
  then fail every mobile-money charge.
- **Hubtel**: authentication only. **Sender-ID approval is separate**, is a
  manual multi-week review on Hubtel's side, and is the longest-lead item in
  the whole launch. `make verify` cannot tell you it is done — check the
  Hubtel portal.

### Why the checks are shaped the way they are

Two of them were wrong on the first attempt, in the same way:

- The Paystack check listed banks — and reported a **completely fabricated key
  as LIVE**, because `/bank` is a public endpoint that ignores the
  Authorization header. A credential check that passes without a credential is
  worse than no check; it manufactures confidence.
- Hubtel reports authentication failure as `status: 4` inside an **HTTP 200**
  body, exactly like Google Maps does. Reading the HTTP code alone reports a
  dead key as healthy.

Both now fail correctly against deliberately fake credentials, which is the
only way to know a check works at all.

## Why the platform e2e runs in lanes

`make test-platform` boots the services in three groups — core, vendor, rider —
one after another, rather than all twelve at once.

This is a memory constraint, and it was measured rather than guessed:

| Configuration | Peak RSS, one service |
|---|---|
| no heap cap | 225 MB |
| `--max-old-space-size=256` | 230 MB |
| `--max-old-space-size=192` | 232 MB |
| `--max-old-space-size=160` | **crashes** — heap OOM during compile |

The memory is the **esbuild/tsx compiler and the Node binary**, not V8
old-space, so `--max-old-space-size` does not reduce it. Capping only starves
the compiler until it dies mid-boot. Twelve services is ~2.7GB; a 2GB box
cannot hold them, and staggering does not help because they all stay resident
once started.

What that looked like before the fix: the OOM killer terminated a service
*after* it had reported healthy, and the failure surfaced as unrelated 503s in
a later suite — three separate debugging sessions chasing a bug that was not
in the code. `deathReport()` in the spec now names an OOM kill explicitly
(exit 137 is `128 + SIGKILL`).

Coverage is unchanged: all 34 assertions still run, at a peak of eight
services instead of twelve. Previously ~1 run in 3 was clean; it is now 3/3.

```bash
make test-platform              # three lanes in sequence (default)
E2E_LANES=all make test-platform   # one process — use this in CI, needs ~4GB
E2E_LANE=rider npx tsx apps/e2e/test/platform.e2e.spec.ts   # one lane
```

## Receiving Paystack webhooks in development

Paystack pushes from its own servers, so it cannot reach localhost. The
webhook is the **source of truth for payment** — a client callback can be
forged, a signed webhook cannot — so it is the one integration that has to be
proven over a real public URL before launch.

```bash
# 1. gateway must be listening first (a tunnel to nothing returns 502)
set -a; . ./.env; set +a
PORT=3000 npx tsx apps/gateway/src/main.ts &

# 2. expose it
NGROK_AUTHTOKEN=... NGROK_DOMAIN=your-name.ngrok-free.dev \
  bash infra/scripts/dev-tunnel.sh

# 3. prove it before pointing Paystack at it
bash infra/scripts/verify-webhook.sh https://your-name.ngrok-free.dev
```

Then in **Paystack → Settings → API Keys & Webhooks**:

| Field | Value |
|---|---|
| Test Webhook URL | `https://<domain>/api/webhooks/paystack` |
| Test Callback URL | **leave blank** |

The callback is deliberately empty. The browser redirect is client-controlled
and must never move money; only the signed webhook does.

`PAYSTACK_WEBHOOK_SECRET` can stay unset — Paystack signs with the secret key
and the config defaults to it.

### Why verify-webhook.sh sends four requests

Reachability is the least interesting property. An endpoint that accepts
everything is worse than one that is down, because a forged `charge.success`
is a free order. All four verdicts must hold:

| Request | Expected |
|---|---|
| genuine signature | 201 accepted |
| same event again | 201 **duplicate**, not handled twice |
| forged signature | 401 |
| no signature | 401 |

A 201 on a forged signature means something in the chain re-serialised the
body — the HMAC covers raw bytes, not parsed JSON, so a proxy that
pretty-prints the payload silently breaks verification.

### Reserved domain

Use one. Without `--domain` ngrok issues a new hostname on every restart and
the Paystack dashboard has to be edited each time — which is how a stale URL
ends up in production config.
