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
| `GOOGLE_MAPS_SERVER_KEY` | Straight-line distance × 1.4 | Real routed distances and ETAs |

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
