# What's Left — honest status

**Date:** 2026-07-26 · Measured this session, not recalled.

Everything below was re-checked by running it. Where a previous version of
this file was optimistic or simply out of date, it has been corrected —
notably section 2, which still listed the gateway, BFFs, outbox relay and
media-svc as unbuilt long after they were working.

---

## What actually exists

| Area | Measured | Status |
|---|---|---|
| Backend + shared libs | ~31,600 lines TS | ✅ Thorough, well-tested |
| Tests | **1,472 green** (868 TS unit + 154 integration + **34 full-platform e2e** + 416 Dart) | ✅ Real, all re-run today |
| **Full-platform e2e** | 11 real services + real PostGIS; customer, vendor AND rider paths | ✅ `make test-platform` — 34/34 |
| SQL migrations | 9 services | ✅ Constraints enforce the invariants |
| **Runnable processes** | **15/15 boot healthy** | ✅ `make run` |
| **Deployment** | One image, `SERVICE_MAIN` selects the service; compose stack | ✅ `make up` |
| Gateway + 4 BFFs | Routing, JWT, rate limiting, degradation | ✅ Working |
| Event bus | RabbitMQ outbox relay, verified end to end | ✅ Working |
| WebSocket transport | Real `ws` server for tracking + chat | ✅ Working |
| **Object storage** | Real SigV4 presigning (S3/R2/B2/Spaces/MinIO) | ✅ **New** — verified against live MinIO |
| **Push** | Real FCM HTTP v1 incl. OAuth2 service-account flow | ✅ **New** — boots with a real key |
| SMS | Hubtel primary, Arkesel failover | 🟡 Real client, never called with live credentials |
| Payments | Paystack charges + signed webhooks, double-entry ledger | 🟡 Real client, never called against the sandbox |
| Maps | Real Google client, caching + budget | 🟡 Real client, never called with a live key |
| **Admin dashboard** | Next.js 16, live data from bff-admin | ✅ **New** — stubs deleted |
| **Flutter apps** | ~16,200 lines Dart | 🟡 See below |

---

## Remaining work

### 1. Mobile breadth — the largest single item 🟡

All three apps boot, sign in over real OTP, and render live data. The
foundations are not in question; the screen count is.

| App | Works today | Missing |
|---|---|---|
| **Customer** | browse → store → cart → checkout → live tracking | map widget, order history, address map picker, chat UI, wallet, prescription upload, shopping-list builder, errand + parcel forms |
| **Rider** | full job flow, proof-of-delivery capture and upload | map/navigation hand-off, COD remittance screen, earnings, chat |
| **Vendor** | order queue, menu management | KYC onboarding, operating hours, earnings, payout request |

`google_maps_flutter` is still not a dependency — tracking renders as a
progress trail, not a map. That is the most visible gap to a pilot user.

### 2. Repository layers still in memory 🟡

Real Postgres repositories exist for identity, catalogue, order, payment and
admin. These still lose their state on restart:

- **dispatch** — claim store falls back to memory without Redis (it *does*
  use Redis when `REDIS_URL` is set, which is what prevents the double-accept
  race; the fallback is dev-only and warns at boot)
- **tracking** — location pings
- **messaging** — chat history (dedupe is now Redis-backed; see below)

**Fixed this session:** notification dedupe was per-process, so two replicas
each treated the same outbox event as new and the customer received two texts
that we paid for twice. It is now Redis-backed and shared, verified with two
dispatchers against one real Redis, and production refuses to start without
`REDIS_URL`.

### 3. Verification against live third parties ❌

Every client is real and wired to env vars. None has been run against real
credentials, because none exist in this environment.

| Provider | Client | Verified against |
|---|---|---|
| Paystack | ✅ real | ❌ sandbox never called |
| Hubtel / Arkesel | ✅ real | ❌ never called; **sender-ID approval not started — longest lead item** |
| Google Maps | ✅ real | ❌ never called; the 89.7% call saving is simulated |
| Firebase FCM | ✅ real | ❌ never pushed to a real device |
| S3 / R2 | ✅ real | ✅ **verified against live MinIO** — signatures accepted, bytes round-tripped |

`docs/RUNNING.md` says how to drop each credential in and confirm it is live.

### 4. Not started ❌

- **CI** — workflow parked at `infra/ci-pending/ci.yml`; the token lacks
  `workflow` scope, so it cannot be pushed to `.github/`
- **Load test** — k6 planned, never run. No idea what breaks first under load
- **Security review** — no external review, no dependency audit in CI
- **Fraud controls** — designed (mock-location detection, POD geofence,
  velocity checks) but not implemented
- **Reconciliation drill** — the payout-halt path has unit tests but has never
  been exercised as an operational rehearsal

---

## Honest completion estimate

Measured against a **pilot** — one Accra zone, Food + Parcel, ~20 vendors —
not against feature-completeness.

| Layer | Done |
|---|---|
| Domain logic & data model | ~90% |
| Service plumbing / transport | ~90% |
| Third-party integration code | ~95% (verification ~20%) |
| Admin dashboard | ~55% |
| **Mobile apps** | **~45%** |
| Ops, CI/CD, infrastructure | ~40% |
| **Overall** | **~78%** |

The parts where mistakes are expensive and hard to undo — money handling,
state machines, the ledger, race conditions — are done and tested. What is
left is mostly volume and verification.

**The single biggest risk is not code.** It is that no third party has ever
answered us. Hubtel sender-ID approval in particular is a multi-week external
dependency that has not been started, and no amount of engineering shortens it.

---

## Recommended order

1. **Live-key verification.** Start Hubtel sender-ID approval *today*; run the
   Paystack sandbox. This is where integration surprises live.
2. **Map widget in the customer and rider apps.** The most visible gap.
3. **Remaining repository layers** (tracking, messaging chat history).
4. **k6 load test**, then fraud controls, then security review.
5. **Pilot.**

---

## What I would want you to decide

1. **Which zone and which two services for the pilot?** Food + Parcel is the
   assumption throughout; confirming it lets a lot of breadth work be cut.
2. **When can Hubtel sender-ID approval start?** It is the longest lead item
   and nothing in the code affects it.
3. **A second pair of hands on mobile.** The three apps parallelise cleanly
   and share packages; this is where a second engineer pays for themselves.
