# BESONC — Phase & Progress Tracker

**Single place to see where we are.** Updated at the end of every work session.
Companion to `MASTER_PLAN.md` (the *what* and *why*). This is the *where are we*.

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked

---

## Status board

| Phase | Sprints | Status | Progress |
|---|---|---|---|
| **P0 — Planning & environment** | — | ✅ **Complete** | ██████████ 100% |
| **P1 — Foundation** | 1–2 | ✅ **Complete** | ██████████ 100% |
| **P2 — Commerce core** | 3–6 | ✅ **Complete** | ██████████ 100% |
| **P3 — Delivery engine** | 7–10 | ✅ **Complete** | ██████████ 100% |
| **P4 — Completion** | 11–14 | 🟡 Sprints 11–12 done | █████░░░░░ 50% |
| **P5 — Launch** | 15–18 | ⬜ Not started | ░░░░░░░░░░ 0% |

**Overall: P0–P3 complete + Sprints 11–12. 368 specs green (309 unit + 59 integration incl. 7 end-to-end).**
**Currently active: Sprint 13–14 — Admin dashboard.**

**All 8 services from the PDF are now implemented.**

**🎉 The system now RUNS.** A real NestJS service over HTTP drives an order
from checkout to settlement against real Postgres.

---

## Issue closure tracker

The 15 spec issues and where each dies. This is the real measure of progress.

| # | Issue | Closing test | Sprint | Status |
|---|---|---|---|---|
| 1 | Ledger example doesn't balance | `ledger.spec` | 5 | ✅ **closed** — 7/7 green, migration committed |
| 2 | COD booked at wrong time | `cod.spec` | 10 | ✅ **closed** — obligation at delivery, 20/20 |
| 3 | Paystack call masking doesn't exist | `messaging.spec` | 11 | ✅ **closed** — consented window, v2 Infobip |
| 4 | Arkesel → Hubtel SMS | `otp.spec` | 2 | ✅ **closed** — failover tested |
| 5 | DECIMAL money | `money.spec` | 1 | ✅ **closed** — 15/15 green |
| 6 | Client callback as payment truth | `webhook.spec` | 6 | ✅ **closed** — signed webhook only, 24/24 |
| 7 | Dispatch accept race | `dispatch.spec` | 8 | ✅ **closed** — 100 riders/10 conns vs real Redis |
| 8 | Directions API cost bomb | `maps.spec` | 3 | ✅ **closed** — 89.7% reduction, 3 calls/order |
| 9 | In-process timers die on deploy | `outbox-timers.spec` | 7 | ✅ **closed** — DB timers, SKIP LOCKED |
| 10 | Laundry/errand break one-delivery model | `outbox-timers.spec` | 7 | ✅ **closed** — DeliveryLeg from migration 001 |
| 11 | search reads catalogue replica | — (merge) | 3 | ✅ **closed** — own tsvector index |
| 12 | No admin audit trail | — (schema) | 13 | [ ] |
| 13 | No payout failure handling | `webhook.spec` | 6 | ✅ **closed** — saga w/ compensation |
| 14 | No OTP rate limiting | `otp.spec` | 2 | ✅ **closed** — 19/19 green |
| 15 | Fraud controls | — | 15 | [ ] |

**14 of 15 closed.**

---

## P0 — Planning & Environment ✅

- [x] Read and analyse `besonc.pdf` (38pp)
- [x] Find and resolve 15 spec issues
- [x] Lock tech decisions (Paystack, internal ledger, Hubtel SMS, Google Maps, microservices)
- [x] Reduce 18 → 15 deployables with justification
- [x] Write `MASTER_PLAN.md` as single source of truth
- [x] Verify toolchain: Node, Flutter, Docker, Compose, Postgres, PostGIS, Redis, RabbitMQ
- [x] **Prove ledger balance constraint rejects unbalanced transactions**
- [x] **Prove Redis atomic claim resolves dispatch race**
- [x] Push to GitHub

---

## P1 — Foundation (Sprints 1–2)

### Sprint 1 — Platform Foundation ✅ **COMPLETE**
*No API keys required.*

- [x] TypeScript workspace (npm workspaces; Nx deferred — see note)
- [x] `libs/money` — pesewa arithmetic, floats banned
- [x] `money.spec` **15/15 green, 1M-op precision test (closes issue 5)**
- [x] `infra/docker/compose.dev.yml` — RAM-aware profiles, 10 service DBs
- [x] `infra/scripts/bootstrap.sh` — restores Flutter, Docker, Compose, remote
- [x] `infra/scripts/test-ledger.sh` — one-command ledger.spec runner
- [x] `svc-payment` ledger migration + deferred balance trigger + append-only
- [x] `ledger.spec` **7/7 green (closes issue 1)**
- [x] Melos workspace, 3 Flutter apps + 8 packages, all analyze clean
- [x] `.env.example` documenting every key we'll need
- [~] GitHub Actions CI — written, **parked in `infra/ci-pending/`** (token lacked `workflow` scope)
- [ ] `libs/platform` — deferred to Sprint 2, lands with the first real service
- [ ] `libs/contracts` — deferred to Sprint 2
- [ ] Service generator — deferred to Sprint 2

**Exit:** `money.spec` + `ledger.spec` green in CI; one service runs end-to-end in Compose.

### Sprint 2 — Identity ✅ **COMPLETE**
*Hubtel adapter built against env vars — real credentials drop in with no code change.*

- [x] `SmsProvider` port + Hubtel primary + Arkesel failover **(closes issue 4)**
- [x] Ghana phone normalisation + MoMo network detection
- [x] `OtpService`: CSPRNG codes, 5-axis rate limiting, brute-force burn
- [x] **`otp.spec` 19/19 green (closes issue 14)**
- [x] `libs/platform/errors` — RFC-7807 problem details
- [x] `libs/auth` — 11 roles, zone scoping, tenant isolation, `rbac.spec` 13/13
- [x] `svc-identity` migration: users, addresses, rider/vendor KYC, sessions, otp_audit
- [x] DB constraints verified live: E.164, GhanaPost format, one-default-address, vehicle docs
- [ ] JWT issuance + refresh rotation — **deferred to Sprint 3** (needs Nest runtime)
- [ ] `gateway` + 4 BFF skeletons — **deferred to Sprint 3**
- [ ] Flutter `besonc_auth` package — **deferred to Sprint 3**

---

## P2 — Commerce Core (Sprints 3–6)

### Sprint 3 — Catalogue, Maps & Pricing ✅ **COMPLETE**
*Maps client built against a transport port — real Google keys drop into env.*
- [x] `libs/maps`: geohash, haversine, Ghana bounds, 1.4 road-winding fallback
- [x] `MapsClient`: geohash-6 route cache, geohash-7 geocode cache, session
      tokens, daily budget caps, graceful degradation
- [x] Deviation-based ETA throttling **(closes issue 8)** — `maps.spec` 23/23,
      **89.7% fewer calls, 3 per clean delivery**
- [x] `svc-pricing`: all PDF §6 tiers, surcharges, commissions, COD rules
- [x] `pricing.spec` 30/30 — canonical GHS 81.50 order reproduces exactly;
      20k random quotes prove the settlement split never leaks a pesewa
- [x] `svc-catalogue` migration: one template, 6 services, addons, variants
- [x] Own tsvector + trigram search index **(closes issue 11)**
- [x] Vendor ranking function (PDF §10 weights), Accra-timezone opening hours
- [x] Live-verified: pharmacy licence gate, addon selection ranges, price floors

### Sprint 4 — Auth tokens & cart ✅ **COMPLETE**
- [x] `TokenService`: HS256 JWT, 15-min access, 30-day refresh
- [x] **Refresh rotation with reuse detection** — replaying a spent token
      revokes the entire session family
- [x] Hardened against alg=none, payload tampering, wrong-secret signing
- [x] `token.spec` 14/14
- [x] `CartService`: server-side re-pricing (client never sends prices)
- [x] One-vendor rule (PDF §13) with the "start a new cart?" message
- [x] Addon min/max/required rules, variants exactly-one, cross-item guard
- [x] Checkout gate: closed vendor, empty cart, prescription upload
- [x] `cart.spec` 21/21 — reproduces the PDF §20 walkthrough cart (GHS 70)
- [ ] NestJS HTTP wiring + gateway/BFFs — **deferred to Sprint 5**
- [ ] `media-svc` — **deferred to Sprint 5**
- [ ] Flutter screens — **deferred to Sprint 6**

### Sprint 5 — Ledger service ✅ **COMPLETE**
- [x] `LedgerService`: pre-flight balance validation before the DB is touched
- [x] Idempotent postings keyed on `reference` — replayed webhooks are safe
- [x] Canonical postings: capture, PSP fee, settle (prepaid + COD),
      COD obligation, remittance, refund, payout, payout reversal
- [x] `PgLedgerRepository` — one DB transaction per posting so the deferred
      constraint fires at COMMIT
- [x] Withdrawal guards: rider wallet minus unremitted COD; vendor 24h hold
- [x] **`ledger-service.spec` 16/16 against real Postgres**, including
      idempotency under 5 replayed captures and a full replay-vs-materialised
      balance reconciliation
- [x] `infra/scripts/test-db.sh` — DB integration runner
- [ ] Nightly reconciliation job — **Sprint 6** (pairs with Paystack settlement pull)

### Sprint 6 — Paystack ✅ **COMPLETE**
*Built against a transport port; real keys drop into env. Not yet run against
Paystack's sandbox — see "Verification pending" below.*
- [x] `PaystackClient`: MoMo charge (mtn/vod/atl), card init, verify, refund,
      transfer recipients, transfers
- [x] Deterministic `chargeReference` per attempt — retries cannot double-charge
- [x] **Signed webhook pipeline (closes issue 6)** — HMAC-SHA512 on the raw
      body, constant-time compare, dedupe, always-200
- [x] **Payout saga (closes issue 13)** — compensation on failed/reversed,
      handles Paystack reversing an already-successful transfer
- [x] PSP fees booked to `PLATFORM_FEES_EXPENSE`, never netted
- [x] Nightly reconciliation: 3-way check + payout halt on drift
- [x] `webhook.spec` 24/24, `reconciliation.spec` 9/9

---

## P3 — Delivery Engine (Sprints 7–10)

### Sprint 7 — Order Engine
- [ ] `order-svc`, state machines A + D
- [ ] `DeliveryLeg` model **(closes issue 10)**
- [ ] Transactional outbox relay
- [ ] Durable BullMQ timers **(closes issue 9)** — `timers.spec`

### Sprint 8 — Dispatch ✅ **COMPLETE**
- [x] 3-round broadcast 3km → 5km → 8km, 3 riders, 30 s each (PDF §4)
- [x] **Redis `SET NX PX` atomic claim (closes issue 7)**
      - in-memory: 50 concurrent + 200 repeated trials, always 1 winner
      - **real Redis: 100 riders across 10 connections → exactly 1 winner**
      - losers are told who won, so the UI can say "taken"
- [x] Vehicle capability matrix, weight limits, fragile-items-cars-only
- [x] COD gating on the balance AFTER this order, not before
- [x] Cancellation sidelining (3/day), acceptance-rate tie-breaking
- [x] Escalation: rounds → 60 s retries → give up with a refund offer
- [x] Redis GEO nearest-first, claim TTL so a stuck leg self-recovers
- [x] `dispatch.spec` 25/25, `dispatch-redis.spec` 4/4

### Sprint 9 — NestJS wiring ✅ **COMPLETE**
*Re-scoped from Tracking: 6,000 lines of domain logic had no HTTP layer.*
- [x] NestJS 11 + Fastify verified booting in this environment
- [x] `libs/platform/http`: RFC-7807 exception filter, correlation middleware
- [x] `order-svc` HTTP: create, fetch, apply event, history, legs, health/ready
- [x] `OrderModule.forRoot(pool)` dynamic module (Nest DI is per-module)
- [x] Row-level `SELECT ... FOR UPDATE` on transitions
- [x] Settlement split computed and written in the SAME statement as
      `delivered`, so the balance constraint never sees an invalid row
- [x] **`order-flow.e2e.spec` 7/7 — real HTTP, real Postgres:**
      checkout → payment → vendor accept → prepare → ready → assign →
      pickup → arrive → deliver → settle, with ledger balances verified
      and global drift = 0
- [x] Verified live: vendor timer created on payment and cancelled on accept,
      9 history rows, 8+ outbox events, RFC-7807 errors with correlation IDs,
      concurrent double-accept → exactly one 201 and one 409

### Sprint 10 — Tracking + COD ✅ **COMPLETE**
- [x] **COD obligation booked at DELIVERY (closes issue 2)** — `cod.spec` 20/20
      against real Postgres; obligation + settlement in one moment, cash
      holding nets to zero, global drift 0 after the full cycle
- [x] Short payment raises a dispute — never a silent write-off
- [x] Escalation: holding → blocked (>GHS 300, cash orders only) →
      warned (24h) → **suspended from ALL work (48h)**
- [x] Partial remittance, over-remittance rejected
- [x] Refusal-to-pay: 5-minute wait enforced server-side, 3 strikes revoke COD
- [x] Float report — total outstanding, ranked collections queue
- [x] `svc-tracking`: ping validation rejecting **mock locations**,
      implausible jumps, stale/inaccurate fixes, out-of-Ghana positions
- [x] Geofencing: enter/exit edges only, auto-emits arrival events
- [x] `TrackingHub`: room-per-order, 3 s broadcast throttle, no cross-order leakage
- [x] Subscribe-time authorisation — only the customer/vendor on that order
- [x] `tracking.spec` 24/24

### Sprint 10 — COD
- [ ] Obligation ledger at delivery **(closes issue 2)** — `cod.spec`
- [ ] Remittance, balance gating, strikes, refusal-to-pay

---

## P4 — Completion (Sprints 11–14)

### Sprint 11 — Messaging ✅ **COMPLETE**
*Push built against a provider port; Firebase creds drop into env.*
- [x] 14 notification templates covering the full order lifecycle
- [x] **Idempotent dispatch** — a redelivered event notifies exactly once
- [x] **Critical fallback**: a failed critical push falls back to SMS;
      a failed non-critical push does NOT burn SMS credit
- [x] SMS segment accounting (GSM-7 vs UCS-2); a test asserts every
      SMS-bound template fits in ONE segment at maximum field lengths
- [x] Parcel recipient SMS tracking link (no app required)
- [x] Chat windows: participant checks, 30-minute post-delivery grace
- [x] **Consented calling (closes issue 3 v1)** — number released only inside
      the delivery window, never after; Infobip masking in Phase 2
- [x] `messaging.spec` 25/25

### Sprint 12 — Remaining engines ✅ **COMPLETE**
*State machines A–E were all built in Sprint 7; this is the business logic.*
- [x] **Pharmacy review**: approve / reject / modify. A pharmacist may reduce
      but never increase; non-substitutable medicines are protected; a review
      can never raise the bill; every change carries a customer-readable reason
- [x] Approval blocked when prescription items have no document on file
- [x] **Errand settlement**: underspend refunds, ≤15% auto-charges,
      >15% requires explicit approval and takes **nothing** without it
- [x] Receipts mandatory before any overage; refunds need none
- [x] Top-up requests need amount + reason + photo evidence
- [x] Unavailable items offer substitute-or-refund with a price delta
- [x] **Market shopping list**: validation, 30-item cap, estimate totalling
- [x] **Laundry**: per-item and per-bag pricing, both delivery fees quoted
      up front, ready-time estimate
- [x] Two-leg settlement — **trip-1 rider paid immediately, vendor only after
      the return leg**; different riders per leg supported
- [x] Return leg gated on vendor completion; overdue processing surfaced
- [x] `engines.spec` 31/31

### Sprint 13–14 — Admin Dashboard
- [ ] Next.js 15 + CASL RBAC, 9 roles
- [ ] Live ops map, orders, approvals, ledger explorer
- [ ] Pricing config, zones, reports
- [ ] Audit log **(closes issue 12)**

---

## P5 — Launch (Sprints 15–18)

### Sprint 15–16 — Hardening
- [ ] k6 load test, broker chaos test
- [ ] Fraud controls **(closes issue 15)**
- [ ] Security review, Ghana network conditions, reconciliation drill
- [ ] Android + iOS builds in CI *(needs Apple Developer + Play Console)*

### Sprint 17–18 — Pilot
*Needs: **Paystack live keys** — deployed by you, not me.*
- [ ] One Accra zone (Osu / Cantonments)
- [ ] Food + Parcel only, others behind flags
- [ ] 20 vendors, 15 riders onboarded
- [ ] Daily reconciliation running clean

---

## Blockers & dependencies

| Item | Needed by | Status |
|---|---|---|
| GitHub token | pushes | ✅ used; **revoke when done** |
| Hubtel account + sender ID | Sprint 2 | 🔴 **apply now** — external approval |
| Google Maps keys | Sprint 3 | ⬜ |
| Paystack test keys | **sandbox verification** | 🟡 code complete, needs a live sandbox run |
| Firebase FCM/APNs | Sprint 11 | ⬜ |
| Apple Dev + Play Console | Sprint 16 | ⬜ |
| Paystack live keys | Sprint 17 | ⬜ |
| Hosting decision | Sprint 1 | ⬜ default: DigitalOcean DOKS |
| Team size | Sprint 1 | ⬜ default: 15 deployables |
