# What's Left — honest status

**Date:** 2026-07-25 · Measured, not estimated from memory.

---

## What actually exists

| Area | Measured | Status |
|---|---|---|
| Backend + shared libs | ~61,000 lines TS | ✅ Thorough, well-tested |
| Tests | **980 specs green** (527 TS unit + 133 TS integration + 320 Dart) | ✅ Real, incl. end-to-end |
| SQL migrations | 9 services | ✅ Constraints enforce invariants |
| Admin dashboard | Next.js 16, 4 routes, builds & serves | 🟡 Renders **stubbed data** |
| **Flutter apps** | ~10,000 lines Dart | 🟡 **Customer app runs**; vendor/rider still library-only |
| Shared Dart packages | models, api, ui, auth real; 4 still stubs | 🟡 Partly built |
| HTTP surface | **4 of 11 services** (order, pricing, identity, catalogue) | 🟡 In progress |
| Event bus | RabbitMQ outbox relay, verified end-to-end | ✅ Working |
| WebSocket transport | Real `ws` server for tracking + chat | ✅ Working |

**The headline:** the hard *thinking* is done and verified, the plumbing is
well underway, and one of the three apps now genuinely boots and talks to the
backend. The other two apps and most repository layers remain.

---

## Remaining work

### 1. Mobile — still the largest single item 🟡

The **customer app boots, signs in over real OTP, and renders its home screen
from the BFF**. The vendor and rider apps have tested controllers and one
screen each, but their `main.dart` files are still the counter template.

| App | Screens needed (approx.) |
|---|---|
| **Customer** | onboarding/OTP, address picker w/ map + GhanaPostGPS, 8 service tiles, vendor list + filters, vendor page, item sheet w/ addons & variants, cart, checkout, payment (MoMo/card/COD), live tracking map, order history, chat, wallet, prescription upload, shopping-list builder, errand form, parcel form |
| **Vendor** | OTP, KYC onboarding, dashboard, incoming-order alert (loud, 3-min timer), order management, menu CRUD w/ addon/variant editors, stock toggles, operating hours, earnings, payout request |
| **Rider** | OTP, KYC + vehicle docs, online/offline toggle, background location, offer sheet w/ 30 s countdown, navigation hand-off, status buttons per state, COD collection + balance, remittance, proof-of-delivery camera, earnings, chat |

Plus the 8 shared packages: API client, models, auth, design system, tracking map widget, chat UI, payment UI, utils.

**Realistically ~50–60% of all remaining effort.**

### 2. Service plumbing ❌

- **Gateway** — JWT verification, rate limiting, routing, CORS/Helmet
- **4 BFFs** — customer, vendor, rider, admin (the admin dashboard has no backend today)
- **HTTP for 10 services** — only `svc-order` is reachable
- **Outbox relay → RabbitMQ** — events are written but **never published**; no service reacts to another
- **WebSocket server** — tracking and chat logic exist with no transport
- **`media-svc`** — uploads, compression, S3/R2. Nothing built; blocks menu photos, KYC, POD, receipts

### 3. Verification gaps 🟡

- **Paystack has never run against the sandbox.** Status strings, MoMo webhook payloads and settlement-file format are unconfirmed.
- **Hubtel/Arkesel never called.** Sender-ID approval not started.
- **Google Maps never called.** The 89.7% saving is simulated, not measured.
- **No load test.** k6 planned, not run.
- **No mobile builds in CI.** The workflow is still parked in `infra/ci-pending/` (token lacked `workflow` scope).

### 4. Remaining planned sprints

| Sprint | Work |
|---|---|
| 15–16 | Fraud controls (issue #15 hardening), k6 load test, broker chaos, security review, reconciliation drill |
| 17–18 | Pilot: one Accra zone, Food + Parcel, 20 vendors, 15 riders |

---

## Honest completion estimate

Measuring against a **pilot-ready** platform, not a feature-complete one:

| Layer | Done |
|---|---|
| Domain logic & data model | ~85% |
| Service plumbing / transport | ~15% |
| Admin dashboard | ~20% |
| **Mobile apps** | **~2%** |
| Ops, CI/CD, infrastructure | ~25% |
| **Overall** | **~30–35%** |

The first 35% was the part where mistakes are expensive and hard to undo — money handling, state machines, race conditions, the ledger. That work is genuinely solid. What remains is larger in volume but much better understood.

**Remaining effort: roughly 3,000–4,000 engineering hours** → 5–7 months with 4–6 engineers.

---

## Recommended order

1. **Plumbing first (2 sprints).** Gateway + BFFs + outbox relay + WebSocket. Nothing mobile can be built against libraries — the apps need real endpoints.
2. **Customer app (3–4 sprints).** Proves the whole stack; the other two apps reuse its packages.
3. **Vendor + rider apps (3–4 sprints).** Can run in parallel with different engineers.
4. **Live-key verification (1 sprint).** Paystack sandbox, Hubtel, Google Maps — real calls, real payloads.
5. **Hardening + pilot (4 sprints).**

---

## What I'd want you to decide

1. **Plumbing before mobile, or a vertical slice?** I'd argue plumbing first — but a thin vertical slice (one screen, end to end, real HTTP) would de-risk the API contract earlier.
2. **Live keys** — the sooner Paystack sandbox runs, the sooner integration surprises surface. Hubtel sender-ID approval is still the longest-lead item and hasn't been started.
3. **Team.** Solo, this is well over a year. The mobile work parallelises cleanly across three engineers.
