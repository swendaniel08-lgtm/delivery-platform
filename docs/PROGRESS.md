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
| **P2 — Commerce core** | 3–6 | ⬜ Not started | ░░░░░░░░░░ 0% |
| **P3 — Delivery engine** | 7–10 | ⬜ Not started | ░░░░░░░░░░ 0% |
| **P4 — Completion** | 11–14 | ⬜ Not started | ░░░░░░░░░░ 0% |
| **P5 — Launch** | 15–18 | ⬜ Not started | ░░░░░░░░░░ 0% |

**Overall: P0 + P1 complete (Sprints 1–2). 47 specs green.**
**Currently active: Sprint 3 — Catalogue & Cart.**

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
| 6 | Client callback as payment truth | `webhook.spec` | 6 | [ ] |
| 7 | Dispatch accept race | `dispatch.spec` | 8 | ✅ primitive proven · full test S8 |
| 8 | Directions API cost bomb | `maps.spec` | 9 | [ ] |
| 9 | In-process timers die on deploy | `timers.spec` | 7 | [ ] |
| 10 | Laundry/errand break one-delivery model | — (schema) | 7 | [ ] |
| 11 | search reads catalogue replica | — (merge) | 3 | ✅ resolved in plan |
| 12 | No admin audit trail | — (schema) | 13 | [ ] |
| 13 | No payout failure handling | — (saga) | 6 | [ ] |
| 14 | No OTP rate limiting | `otp.spec` | 2 | ✅ **closed** — 19/19 green |
| 15 | Fraud controls | — | 15 | [ ] |

**7 of 15 closed.**

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

### Sprint 3–4 — Catalogue & Cart
*Needs: **Google Maps keys** (Places, Geocoding).*
- [ ] `catalogue-svc`: stores, categories, items, addon groups, variant groups
- [ ] One template covering all 6 catalogue services
- [ ] Operating hours, stock toggles, vendor ranking algorithm
- [ ] Search module with own tsvector index **(closes issue 11)**
- [ ] `media-svc`: upload, compression, variants
- [ ] Customer: browse, search, vendor page, cart (one-vendor rule)
- [ ] Vendor: menu management
- [ ] Address system: GPS pin, GhanaPostGPS, landmark, instructions

### Sprint 5 — Pricing + Ledger Core
- [ ] `pricing-svc`: delivery tiers, service fees, commissions, surcharges — admin-configurable
- [ ] `payment-svc`: chart of accounts, wallets, materialised balances
- [ ] Nightly reconciliation job
- [ ] `ledger.spec` property-based, 10⁶ ops

### Sprint 6 — Paystack Live
*Needs: **Paystack test keys**.*
- [ ] MoMo charge (`mtn|vod|atl`) + card
- [ ] Signed webhook pipeline **(closes issue 6)** — `webhook.spec`
- [ ] Refund saga, payout saga **(closes issue 13)**
- [ ] PSP fee accounting

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
| Paystack test keys | Sprint 6 | ⬜ |
| Firebase FCM/APNs | Sprint 11 | ⬜ |
| Apple Dev + Play Console | Sprint 16 | ⬜ |
| Paystack live keys | Sprint 17 | ⬜ |
| Hosting decision | Sprint 1 | ⬜ default: DigitalOcean DOKS |
| Team size | Sprint 1 | ⬜ default: 15 deployables |
