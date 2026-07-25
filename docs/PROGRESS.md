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
| **P3 — Delivery engine** | 7–10 | 🟡 Sprint 7 done | ███░░░░░░░ 25% |
| **P4 — Completion** | 11–14 | ⬜ Not started | ░░░░░░░░░░ 0% |
| **P5 — Launch** | 15–18 | ⬜ Not started | ░░░░░░░░░░ 0% |

**Overall: P0–P2 complete + Sprint 7. 232 specs green (204 unit + 28 DB integration).**
**Currently active: Sprint 8 — Dispatch.**

---

## Issue closure tracker

The 15 spec issues and where each dies. This is the real measure of progress.

| # | Issue | Closing test | Sprint | Status |
|---|---|---|---|---|
| 1 | Ledger example doesn't balance | `ledger.spec` | 5 | ✅ **closed** — 7/7 green, migration committed |
| 2 | COD booked at wrong time | `cod.spec` | 10 | [ ] |
| 3 | Paystack call masking doesn't exist | — (design) | 11 | ✅ resolved in plan |
| 4 | Arkesel → Hubtel SMS | `otp.spec` | 2 | ✅ **closed** — failover tested |
| 5 | DECIMAL money | `money.spec` | 1 | ✅ **closed** — 15/15 green |
| 6 | Client callback as payment truth | `webhook.spec` | 6 | ✅ **closed** — signed webhook only, 24/24 |
| 7 | Dispatch accept race | `dispatch.spec` | 8 | ✅ primitive proven · full test S8 |
| 8 | Directions API cost bomb | `maps.spec` | 3 | ✅ **closed** — 89.7% reduction, 3 calls/order |
| 9 | In-process timers die on deploy | `outbox-timers.spec` | 7 | ✅ **closed** — DB timers, SKIP LOCKED |
| 10 | Laundry/errand break one-delivery model | `outbox-timers.spec` | 7 | ✅ **closed** — DeliveryLeg from migration 001 |
| 11 | search reads catalogue replica | — (merge) | 3 | ✅ **closed** — own tsvector index |
| 12 | No admin audit trail | — (schema) | 13 | [ ] |
| 13 | No payout failure handling | `webhook.spec` | 6 | ✅ **closed** — saga w/ compensation |
| 14 | No OTP rate limiting | `otp.spec` | 2 | ✅ **closed** — 19/19 green |
| 15 | Fraud controls | — | 15 | [ ] |

**12 of 15 closed.**

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

### Sprint 8 — Dispatch
- [ ] 3-round broadcast (3km → 5km → 8km)
- [ ] Redis atomic claim **(closes issue 7)** — `dispatch.spec` 50 concurrent
- [ ] Vehicle matching, COD-balance gating, reassignment

### Sprint 9 — Tracking
- [ ] GPS ingest, Socket.IO fanout
- [ ] Google ETA + tiered cache **(closes issue 8)** — `maps.spec`
- [ ] Geofence auto-transitions, customer live map

### Sprint 10 — COD
- [ ] Obligation ledger at delivery **(closes issue 2)** — `cod.spec`
- [ ] Remittance, balance gating, strikes, refusal-to-pay

---

## P4 — Completion (Sprints 11–14)

### Sprint 11 — Messaging
*Needs: **Firebase project (FCM + APNs)**.*
- [ ] Push, Hubtel SMS, in-app, templates
- [ ] Chat (customer↔rider, customer↔vendor), 30-min auto-close
- [ ] Parcel recipient SMS tracking link
- [ ] Consented-call flow **(issue 3 v1)**

### Sprint 12 — Remaining Engines
- [ ] State machine B — pharmacy prescription review
- [ ] State machine C — laundry two legs
- [ ] State machine E — errand, top-up, receipts
- [ ] Market shopping list

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
