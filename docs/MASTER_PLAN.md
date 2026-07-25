# BESONC — Master Engineering Plan
### Multi-Delivery Ecosystem for Ghana

**Version 2.0 — consolidated & issue-resolved**
**Supersedes:** `besonc.pdf` v1.0 (product spec), `TECH_STACK.md`, `BUILD_PLAN.md` v1.1
**Repo:** https://github.com/swendaniel08-lgtm/delivery-platform
**Status:** approved for scaffolding

> This is the single source of truth. Where this document and `besonc.pdf` disagree, **this document wins**. The PDF remains the product/UX reference for screens, copy and business rules not restated here.

---

## PART I — DECISIONS

### 1.1 Locked technology decisions

| Area | Decision |
|---|---|
| Architecture | **True microservices from day 1.** No monolith, no modular-monolith phase. |
| Payments | **Paystack** — collections (MoMo, card, bank transfer) and payouts (Transfers). |
| Money truth | **Internal double-entry ledger.** Paystack is a rail, never the source of truth. |
| SMS | **Hubtel SMS API** (replaces Arkesel in the PDF). Arkesel retained as failover behind an `SmsProvider` interface. |
| Maps / geo / routing / tracking | **Google Maps Platform** — Maps SDK, Places, Directions, Distance Matrix, Geocoding. |
| Mobile | **Flutter** × 3 apps (customer, vendor, rider), Melos monorepo, shared packages. |
| Admin | **Next.js 15** App Router + RBAC (CASL). |
| Backend | **NestJS 11** + Fastify, TypeScript strict, Nx monorepo. |
| Broker | **RabbitMQ** (topic exchange, quorum queues, per-queue DLQ). |
| Database | **PostgreSQL 16**, database-per-service. PostGIS in dispatch + tracking only. |
| Cache / geo-index / locks | **Redis 7** (GEO, atomic claims, idempotency, BullMQ). |
| ORM | **Prisma**, raw SQL for geo + ledger hot paths. |
| Storage | S3-compatible (Cloudflare R2 or DO Spaces). |
| Observability | OpenTelemetry → Grafana (Tempo/Loki/Mimir) + Sentry. |
| Currency | **Integer pesewas (`BIGINT`)** everywhere. GHS formatting at display edge only. |

### 1.2 Non-negotiable engineering rules

These exist because true microservices fail without them. CI enforces each one.

1. **Database-per-service.** No service reads another's tables. Cross-service data via API or event only. *(Enforced: separate DB users, no shared connection strings.)*
2. **Transactional outbox in every write service.** Never `save()` then `publish()`. *(Enforced: lint rule banning direct broker publish outside the outbox relay.)*
3. **Idempotency everywhere.** Every command endpoint takes an `Idempotency-Key`; every event consumer dedupes on `(consumer, event_id)`.
4. **Contracts are code.** `libs/contracts` holds protobuf + event JSON Schema. Nest servers, TS clients and Dart models are all generated. Breaking change without a version bump fails CI.
5. **Money is integer pesewas.** `libs/money` is the only place arithmetic happens. Floats banned by lint.
6. **Correlation ID + OTel span on every hop**, propagated through HTTP, gRPC and AMQP headers.
7. **Every service ships with:** Dockerfile, `/health` + `/ready`, migrations, unit + contract tests, dashboard, alert rules.

### 1.3 Scale decision — 15 deployables, not 18

The PDF specifies 13 services + 4 BFFs + gateway = 18. Three merges reduce operational surface with **zero loss of domain separation**:

| Merge | Rationale |
|---|---|
| `auth-svc` + `user-svc` → **`identity-svc`** | Same aggregate root (the person). Splitting them creates a chatty synchronous dependency on every request. |
| `search-svc` → **`catalogue-svc`** (read module, own index) | The PDF had search reading catalogue's replica, which violates DB-per-service anyway. Same team, same data, same deploy cadence. |
| `chat-svc` + `notification-svc` → **`messaging-svc`** | Both are "deliver a message to a human" with shared template/fanout/WebSocket infrastructure. |

**Final: 15 deployables** = 1 gateway + 4 BFFs + 10 domain services.
If team size ≥ 8 engineers, split them back out — the module boundaries are drawn so this is a config change, not a refactor.

---

## PART II — RESOLVED ISSUES

All 15 issues found in `besonc.pdf`, with the binding resolution. Items marked **[TEST]** have a named test that must pass before the sprint closes — that is what "fixed" means.

| # | Issue | Resolution | Closes in |
|---|---|---|---|
| 1 | §7 ledger example books vendor 42.50 / platform 10.50; §20 books 59.50 / 14.00 for the same order. §7 doesn't balance. | §20 is correct: 59.50 + 8.00 + 14.00 = 81.50. Canonical entries in §3.4 below. **[TEST]** `ledger.spec: every transaction balances` | S5 |
| 2 | COD obligation booked at `placed` — cash doesn't exist yet; vendor/rider/platform split missing entirely. | Obligation booked at **`delivered`**. Full corrected entry set in §3.5. **[TEST]** `cod.spec: obligation only exists post-delivery` | S10 |
| 3 | "Masked numbers via Paystack's masking service" — Paystack has no such product. | **v1: in-app chat + consented direct call** (numbers exchanged only between `rider_assigned` and delivered+30min, auto-revoked). **v2: Infobip Number Masking** (confirmed product) or Twilio Proxy. Hubtel voice-masking unverified — do not assume. | S11 / Phase 2 |
| 4 | SMS via Arkesel. | **Hubtel SMS**, behind `SmsProvider` interface, Arkesel as automatic failover. OTP delivery failure = zero signups, so dual-provider from day 1. | S2 |
| 5 | Prices as `DECIMAL`. | **`BIGINT` pesewas.** `libs/money` owns all arithmetic; float literals in money paths fail lint. **[TEST]** `money.spec: property-based, no precision loss over 10⁶ ops` | S1 |
| 6 | Payment confirmed from client callback. | **Signed webhook is the only source of truth.** Verify `x-paystack-signature` (HMAC-SHA512 of raw body with secret key), persist raw event, return 200 within 30s, process async and idempotently on `data.reference`. Client callback is a UX hint that triggers a poll, nothing more. **[TEST]** `webhook.spec: replayed event produces exactly one ledger transaction` | S6 |
| 7 | Broadcast to 3 riders, first-to-accept — race condition. | **Redis `SET assignment:{id}:winner {riderId} NX PX 30000`** decides the winner atomically; loser gets 409. Backed by a Postgres partial unique index `UNIQUE(leg_id) WHERE status='accepted'`. **[TEST]** `dispatch.spec: 50 concurrent accepts → exactly 1 winner` | S8 |
| 8 | Directions API every 30s per active order — cost bomb. | Tiered caching + interpolation strategy, §5. Budget: **≤3 Directions calls per order**. **[TEST]** `maps.spec: simulated 1000-order day stays under call budget` | S9 |
| 9 | Vendor 3-min auto-reject, rider 30s offer timeout — in-process timers die on redeploy. | **BullMQ delayed jobs** (Redis-persisted), idempotent on fire, re-checked against current state before acting. **[TEST]** `timers.spec: kill worker mid-timer → job still fires exactly once` | S7 |
| 10 | Laundry = 2 trips, errand = top-ups. Breaks "one order = one delivery". | **`Order 1..N DeliveryLeg`** from the first migration. Every service treats legs as first-class. §4. | S7 |
| 11 | search-svc reads catalogue_db replica — violates DB-per-service. | Merged into `catalogue-svc` as a read module with its own tsvector index, fed by domain events. | S3 |
| 12 | admin-svc has no audit trail. | Append-only `audit_log`: actor, role, action, entity, before/after JSON, IP, correlation ID, timestamp. Required for finance disputes. No UPDATE/DELETE grant on the table. | S13 |
| 13 | No refund/settlement failure handling. Paystack transfers *do* fail. | Payouts are a **saga**: `pending → queued → success \| failed \| reversed`, driven by `transfer.success` / `transfer.failed` / `transfer.reversed` webhooks. On failure: reverse the ledger hold, notify, surface in admin manual-resolution queue. Refunds track `refund.pending/processing/processed/failed`. | S6 |
| 14 | No OTP rate limiting — SMS pumping is real money loss in Ghana. | Per-phone (3/hr, 10/day), per-IP (20/hr), per-device throttles; exponential backoff; SIM-country allowlist (GH only at launch); Hubtel daily spend alarm. **[TEST]** `otp.spec: 4th request in an hour is rejected` | S2 |
| 15 | Fraud controls limited to COD strikes. | v1 controls: `isMockLocation` detection, rider-customer collusion velocity checks, POD photo + geofence stamp required to close a leg, device fingerprinting, new-customer COD cap (GHS 50 under 3 orders, per PDF §7). | S15 |

---

## PART III — SYSTEM DESIGN

### 3.1 Service inventory (15 deployables)

**Edge**

| Service | Responsibility |
|---|---|
| `gateway` | JWT verification, rate limiting, CORS/Helmet, routing, correlation-ID injection |
| `bff-customer` | Customer Flutter app + customer web |
| `bff-vendor` | Vendor Flutter app + vendor web |
| `bff-rider` | Rider Flutter app |
| `bff-admin` | Next.js admin; aggregation + audit logging |

**Domain**

| Service | DB | Owns |
|---|---|---|
| `identity-svc` | identity_db | Phone OTP (Hubtel), Google/Apple, JWT + refresh rotation, sessions, profiles for all 4 roles, addresses, Ghana Card KYC, onboarding state |
| `catalogue-svc` | catalogue_db | Stores, categories, items, addon groups, variant groups, stock, operating hours, **search index**, ranking |
| `order-svc` | order_db | Cart, order aggregate, **5 state machines**, `DeliveryLeg`, cancellation, substitution, prescription review |
| `pricing-svc` | pricing_db | Delivery fee tiers, service fees, commissions, surcharges, errand/parcel estimation — all admin-configurable, versioned |
| `dispatch-svc` | dispatch_db + Redis GEO | 3-round broadcast, atomic claim, vehicle matching, reassignment, COD-balance gating |
| `tracking-svc` | Redis + PG history | GPS ingest, Socket.IO fanout, Google ETA + cache, geofence transitions |
| `payment-svc` | payment_db | **Paystack + double-entry ledger + wallets + COD + settlement + payouts + refunds** |
| `messaging-svc` | messaging_db | FCM/APNs push, Hubtel SMS, in-app, templates, customer↔rider and customer↔vendor chat |
| `media-svc` | media_db + S3 | Uploads, compression, variants; prescription / receipt / POD photos |
| `admin-svc` | admin_db | Back-office ops, approvals, reports, **audit log**, feature flags |

### 3.2 The 8 services, 2 engines (from PDF, unchanged)

**Catalogue engine** (customer + vendor + rider): Food, Groceries, Shop, Market-catalogue, Pharmacy, Laundry.
**Request engine** (customer + rider only): Parcel, Errand.
Market is hybrid: catalogue browse for onboarded vendors, **shopping list** using the errand pre-auth/settlement model for non-onboarded sellers.

Service-specific rules preserved: Shop is **prepaid only, never COD**. Pharmacy requires licence verification + prescription review state. Laundry produces **two legs** with a `processing` period between. Groceries/Market carry unit types + substitution preference.

### 3.3 Payment architecture — Paystack (verified against live API)

**Collections**
- Mobile money: `POST /charge` with `currency: "GHS"`, `mobile_money: { phone, provider }` where provider ∈ `mtn | vod | atl`. Async — customer approves a prompt on their handset.
- Card: Transaction Initialize + Paystack Flutter SDK/webview. 3DS handled by Paystack; **we never touch PAN or PIN** (keeps PCI scope out).
- Bank transfer + Dedicated Virtual Accounts: supported in Ghana, useful for large vendor top-ups later.
- Reference format: `ord_{orderId}_a{attempt}` — deterministic, so retries can't double-charge.

**Webhooks — the only source of truth**

| Event | Action |
|---|---|
| `charge.success` | Capture: `PAYSTACK_INFLOW → PLATFORM_HOLDING`, then `order.payment_confirmed` |
| `refund.pending / .processing / .processed / .failed` | Drive refund saga state |
| `transfer.success / .failed / .reversed` | Drive payout saga; on failed/reversed, reverse the ledger hold and raise an admin task |
| `charge.dispute.create / .resolve` | Open dispute case, freeze related vendor/rider withdrawal |

Handler contract: verify HMAC-SHA512 signature against the **raw** body → persist raw event → enqueue → **return 200 within 30s** → process idempotently keyed on the Paystack event id.

**Payouts.** Paystack Transfers to MoMo/bank. Transfer recipients created once per vendor/rider and cached. HTTP 200 means the *API call* succeeded, not the transfer — status must come from `data.status` or, preferably, the webhook.

**Errand / market-list pre-auth.** Paystack has **no true auth-and-capture for Ghana mobile money**. Therefore, as the PDF describes: charge the full estimate up front, settle afterwards, refund any difference to wallet. Over-spend within 15% is auto-charged; beyond 15% requires an in-app top-up approval. This must be stated plainly in the customer UI — it is a real UX constraint, not an implementation detail.

**Fees.** Paystack's ~1.95% is a real cost and is booked to `PLATFORM_FEES_EXPENSE`, never silently netted.

### 3.4 Double-entry ledger

**Schema**

```sql
ledger_accounts(
  id, account_type, owner_id NULL, currency 'GHS',
  normal_balance 'debit'|'credit',
  UNIQUE(account_type, owner_id))

ledger_transactions(
  id, reference UNIQUE,          -- 'order:{id}:settlement' → idempotency
  type, order_id, description, metadata jsonb, created_at)

ledger_entries(                  -- append-only; no UPDATE, no DELETE
  id, transaction_id FK, account_id FK,
  direction 'debit'|'credit',
  amount_pesewas BIGINT CHECK (amount_pesewas > 0),
  created_at)

account_balances(                -- materialised, same transaction
  account_id PK, balance_pesewas, available_pesewas,
  pending_pesewas, version BIGINT)
```

**Invariant** — a `DEFERRABLE INITIALLY DEFERRED` constraint trigger asserts `SUM(debits) = SUM(credits)` per `transaction_id` at COMMIT. An unbalanced transaction **cannot commit**. Corrections are reversing entries, never edits. A nightly job re-asserts `SUM(all entries) = 0` and that `account_balances` equals a full replay of `ledger_entries`.

**Chart of accounts**

```
PLATFORM_REVENUE           credit    commissions + service fees
PLATFORM_HOLDING           credit    customer money held pre-settlement
PLATFORM_CASH_HOLDING      credit    COD cash in the field
PLATFORM_FEES_EXPENSE      debit     Paystack fees absorbed
PLATFORM_PROMO_EXPENSE     debit     goodwill, absorbed refunds
CUSTOMER_WALLET_{id}       credit    liability to customer
VENDOR_WALLET_{id}         credit
RIDER_WALLET_{id}          credit
RIDER_COD_OBLIGATION_{id}  debit     rider owes platform cash
PAYSTACK_INFLOW            debit
PAYSTACK_OUTFLOW           credit
```

**Canonical prepaid order** — items 70.00, delivery 8.00, service fee 3.50, total **81.50**; food commission 15% of 70.00 = 10.50.

`T1 order:{id}:capture` (on verified `charge.success`)

| Account | Debit | Credit |
|---|---:|---:|
| PAYSTACK_INFLOW | 81.50 | |
| PLATFORM_HOLDING | | 81.50 |

`T2 order:{id}:settlement` (on `order.delivered`)

| Account | Debit | Credit |
|---|---:|---:|
| PLATFORM_HOLDING | 81.50 | |
| VENDOR_WALLET | | 59.50 |
| RIDER_WALLET | | 8.00 |
| PLATFORM_REVENUE | | 14.00 |

`T3 order:{id}:psp_fee` (Paystack fee 1.59)

| Account | Debit | Credit |
|---|---:|---:|
| PLATFORM_FEES_EXPENSE | 1.59 | |
| PAYSTACK_INFLOW | | 1.59 |

### 3.5 COD — corrected sequence

`T1 order:{id}:cod_obligation` — **at `delivered`**, when cash physically changes hands

| Account | Debit | Credit |
|---|---:|---:|
| RIDER_COD_OBLIGATION | 81.50 | |
| PLATFORM_CASH_HOLDING | | 81.50 |

`T2 order:{id}:settlement` — same moment; earnings recognised per PDF §7

| Account | Debit | Credit |
|---|---:|---:|
| PLATFORM_CASH_HOLDING | 81.50 | |
| VENDOR_WALLET | | 59.50 |
| RIDER_WALLET | | 8.00 |
| PLATFORM_REVENUE | | 14.00 |

`T3 order:{id}:cod_remittance` — rider remits via MoMo

| Account | Debit | Credit |
|---|---:|---:|
| PAYSTACK_INFLOW | 81.50 | |
| RIDER_COD_OBLIGATION | | 81.50 |

**Withdrawal guard:** rider withdrawable = `RIDER_WALLET.available − RIDER_COD_OBLIGATION.balance`. Without this, riders cash out and disappear with the float. COD gating rules from PDF §7 retained: ≤ GHS 200/order, no Shop, GHS 50 cap under 3 orders, rider blocked above GHS 300 unremitted, no COD after 21:00, 24h warning / 48h suspension.

### 3.6 Order model — legs are first-class

```
Order
├── service_type   food|groceries|shop|market|pharmacy|laundry|parcel|errand
├── engine         catalogue | request
├── state          per state machine A–E
├── OrderItems[]   → addons[] | variants[]
├── PriceBreakdown immutable pesewa snapshot taken at checkout
├── PaymentIntent  prepaid | cod | wallet | mixed
└── DeliveryLegs[] 1 for most · 2 for laundry · 1 for parcel/errand
      ├── leg_type  vendor_to_customer | customer_to_vendor
      │             | vendor_to_customer_return | pickup_to_dropoff | task_to_customer
      ├── pickup / dropoff location
      ├── assigned_rider_id, assignment_id
      ├── state, fee_pesewas
      └── proof: photos, geofence stamp, COD confirmation
```

State machines **A** (standard catalogue), **B** (pharmacy + prescription), **C** (laundry, two legs), **D** (parcel), **E** (errand + top-up) are implemented as explicit transition tables: `(from_state, event, guard) → (to_state, emitted_events)`. Illegal transitions throw. The table is exhaustively unit-tested and is the contract all three apps render against.

### 3.7 Google Maps cost strategy

All-Google is correct for Ghana data quality, but naive usage costs more than the commission earned. Binding rules:

| Use | API | Control |
|---|---|---|
| Address search | Places Autocomplete | **Session tokens mandatory**, 300ms debounce, min 3 chars |
| Pin → area name | Reverse Geocoding | Cache by geohash-7, 30-day TTL |
| Delivery fee distance | Distance Matrix | Cache `geohash6:geohash6`, 24h; ~85% hit rate expected in dense Accra |
| Rider ETA in flight | Directions | Recompute only when rider moves >300m **or** >90s elapsed **or** route deviates; interpolate client-side between |
| Rider navigation | **Deep link to Google Maps app** | Free. Do not build in-app turn-by-turn |
| Map display | Maps SDK | Lite mode for thumbnails; one live map at a time |
| Fallback | — | Directions failure → straight-line × 1.4 (PDF §5) |

Plus a nightly precomputed **vendor × zone-centroid** distance matrix, which removes most checkout-time calls. Hard daily quota caps and billing alerts per key; separate restricted keys per app.

Ghana addressing preserved: GPS pin is primary, GhanaPostGPS optional, **landmark field prominent**, delivery instructions free-text.

### 3.8 Events (RabbitMQ topic exchange `besonc.events`)

```
identity.user.registered · identity.kyc.submitted · identity.kyc.approved
catalogue.store.approved · catalogue.item.updated · catalogue.hours.changed
order.created · order.placed · order.vendor_accepted · order.vendor_rejected
order.preparing · order.ready_for_pickup · order.leg.assigned
order.picked_up · order.in_transit · order.arrived · order.delivered
order.leg.completed · order.cancelled · order.prescription.reviewed
dispatch.offer.broadcast · dispatch.offer.accepted · dispatch.offer.expired
dispatch.assignment.failed · dispatch.rider.cancelled
tracking.location.updated · tracking.geofence.entered · tracking.eta.updated
payment.charge.succeeded · payment.charge.failed · payment.settled
payment.refunded · payment.cod.obligation_created · payment.cod.remitted
payment.payout.succeeded · payment.payout.failed
messaging.dispatch_requested
```

Envelope: `{ id, type, version, occurredAt, correlationId, causationId, actor, payload }`.
Published via outbox relay. Consumed idempotently. DLQ per queue with an admin replay tool.

### 3.9 Repository layout

```
delivery-platform/
├── apps/
│   ├── gateway/
│   ├── bff-customer/  bff-vendor/  bff-rider/  bff-admin/
│   ├── svc-identity/  svc-catalogue/  svc-order/    svc-pricing/
│   ├── svc-dispatch/  svc-tracking/   svc-payment/  svc-messaging/
│   ├── svc-media/     svc-admin/
│   └── web-admin/                      ← Next.js 15
├── libs/
│   ├── contracts/     ← proto + event schemas (generation source)
│   ├── platform/      ← logging, otel, config, RFC-7807 errors, outbox, idempotency
│   ├── auth/          ← JWT guard + CASL abilities (shared with web-admin)
│   ├── money/         ← pesewa arithmetic; the only place money math lives
│   └── testing/
├── mobile/                             ← Melos workspace
│   ├── apps/customer/  vendor/  rider/
│   └── packages/ besonc_api  besonc_models  besonc_auth  besonc_ui
│                 besonc_tracking  besonc_chat  besonc_payments  besonc_utils
├── infra/
│   ├── docker/ compose.dev.yml  compose.obs.yml
│   ├── k8s/  terraform/
│   └── scripts/bootstrap.sh            ← restore Flutter SDK + start Docker
└── docs/ MASTER_PLAN.md  ADR/  besonc.pdf
```

---

## PART IV — DELIVERY

### 4.1 Roadmap

Each sprint is two weeks. **Exit criteria are the named tests** — a sprint is not done until they are green in CI.

| Sprint | Focus | Exit criteria |
|---|---|---|
| **1** | Platform foundation | Nx repo, service generator, `libs/platform` + `libs/money`, compose stack (Postgres×N, Redis, RabbitMQ, MinIO, Jaeger, Grafana), CI, one service deployed end-to-end. **`money.spec` green** (issue 5) |
| **2** | Identity | `identity-svc`: Hubtel OTP + Arkesel failover, JWT + rotating refresh, profiles, addresses, KYC. Gateway + 4 BFF skeletons. CASL RBAC shared lib. Flutter shared auth package. **`otp.spec` green** (issue 14) |
| **3–4** | Catalogue & cart | `catalogue-svc` (one template, 6 catalogue services), search module, `media-svc`. Customer browse/search/cart; vendor menu management. Search owns its index (issue 11) |
| **5** | Pricing + **ledger core** | `pricing-svc`; `payment-svc` ledger schema, balanced-transaction constraint trigger, wallets. **No Paystack code yet.** **`ledger.spec` green** — property-based, proves issue 1 |
| **6** | Paystack live | MoMo + card charge, signed webhook pipeline, refund saga, payout saga, nightly reconciliation. **`webhook.spec` green** (issues 6, 13) |
| **7** | Order engine | `order-svc`, state machines A + D, **`DeliveryLeg` model** (issue 10), outbox relay, vendor accept/prepare/ready, durable timers. **`timers.spec` green** (issue 9) |
| **8** | Dispatch | 3-round broadcast, Redis atomic claim, vehicle matching, rider accept/decline. **`dispatch.spec` green** — 50 concurrent accepts, 1 winner (issue 7) |
| **9** | Tracking | GPS ingest, Socket.IO fanout, Google ETA + cache, geofence auto-transitions, customer live map. **`maps.spec` green** — 1000-order day under call budget (issue 8) |
| **10** | COD | Obligation ledger at delivery, remittance via Paystack, balance gating, strikes, refusal-to-pay flow. **`cod.spec` green** (issue 2) |
| **11** | Messaging | FCM/APNs, Hubtel SMS, chat, parcel-recipient SMS tracking link, consented-call flow (issue 3) |
| **12** | Remaining engines | State machines B (prescription), C (laundry two-leg), E (errand + top-up + receipts); market shopping list |
| **13–14** | Admin dashboard | Live ops map, orders, vendor/rider approvals, ledger explorer, pricing config, zones, reports, **audit log** (issue 12) |
| **15–16** | Hardening | k6 load test, broker chaos test, security review, **fraud controls** (issue 15), Ghana network conditions, reconciliation drill |
| **17–18** | Pilot | One Accra zone (Osu/Cantonments). **Food + Parcel only**, other services behind flags. 20 vendors, 15 riders, daily reconciliation |

### 4.2 Effort & staffing

15 deployables + 3 Flutter apps + admin ≈ **4,000–5,500 engineering hours**.

| Team | Time to pilot |
|---|---|
| 6 engineers (2 backend, 2 Flutter, 1 web, 1 infra) | ~7 months |
| 4 engineers | ~10 months |
| 2 engineers | ~16 months — not recommended for microservices |

### 4.3 Launch scope (recommended, adjustable)

**In:** Food + Parcel · prepaid MoMo/card + COD · one Accra zone · all three apps · admin core.
**Behind flags:** Groceries, Shop, Market, Pharmacy, Laundry, Errand.
**Deferred to Phase 2** (per PDF §21): ratings, tips, promo codes, scheduling, multi-vendor cart, wallet top-up, automatic surge, vendor subscriptions, VoIP, dispute system, email.

### 4.4 Build environment

| Capability | Status |
|---|---|
| Node 20, NestJS, Next.js, Nx | ✅ verified |
| Docker + Compose (Postgres, Redis, RabbitMQ) | ✅ verified — `sudo dockerd` per session |
| Flutter 3.35.7 / Dart 3.9.2 — create, test, analyze, build web | ✅ verified |
| Android APK | ⚠️ CI only (RAM-constrained locally) |
| iOS IPA | ❌ CI only (macOS runner — Codemagic or GitHub Actions) |

`infra/scripts/bootstrap.sh` restores the Flutter SDK and starts Docker in a fresh session, since only `/home/user` persists.

---

## PART V — REMAINING DEPENDENCIES

Not engineering unknowns — **procurement items**. None block Sprint 1.

| # | Item | Needed by | Owner |
|---|---|---|---|
| 1 | Paystack Ghana account + test keys | Sprint 6 | You |
| 2 | Paystack **live** keys + settlement bank account | Sprint 17 | You |
| 3 | Hubtel SMS account + sender ID (sender IDs need pre-approval — start early) | Sprint 2 | You |
| 4 | Google Cloud billing account + restricted Maps keys | Sprint 3 | You |
| 5 | Firebase project (FCM + APNs cert) | Sprint 11 | You |
| 6 | Apple Developer + Google Play accounts | Sprint 16 | You |
| 7 | Hosting target — **recommendation: Hetzner + k3s** (cheap, EU latency acceptable to GH) or DigitalOcean DOKS | Sprint 1 | Decide |
| 8 | Team size — determines 15 vs 18 deployables | Sprint 1 | Decide |

Defaults applied if you say nothing: **DigitalOcean DOKS**, **15 deployables**, **Food + Parcel pilot**.

---

## PART VI — NEXT ACTION

Sprint 1, ready to execute on approval:

1. Nx workspace + service generator (Dockerfile, health, OTel, outbox, migrations, tests wired in)
2. `libs/money` — pesewa arithmetic with property-based tests **(closes issue 5)**
3. `libs/platform`, `libs/contracts`, `libs/auth`
4. `infra/docker/compose.dev.yml` — full local platform
5. `svc-payment` ledger schema + balanced-transaction constraint + failing-then-passing tests **(closes issue 1)**
6. Melos mobile workspace, three Flutter apps building
7. GitHub Actions CI (Nx affected) — push everything to the repo

Two issues verifiably dead at the end of Sprint 1, thirteen scheduled against named tests.
