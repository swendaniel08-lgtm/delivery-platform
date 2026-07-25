# Environment Readiness Report

**Date:** 2026-07-25 · **Verdict: GO for Sprint 1** (with 3 known constraints)

Everything below was executed, not assumed.

---

## 1. Verified working

| Capability | Test run | Result |
|---|---|---|
| Node / npm | `node -v`, `npm -v` | ✅ v20.20.2 / 10.8.2 |
| Flutter SDK | `flutter --version` | ✅ 3.35.7 stable |
| Dart | `dart --version` | ✅ 3.9.2 |
| Docker engine | `docker run alpine` | ✅ 26.1.5, daemon running |
| **Docker Compose** | `docker compose up` 3-service stack | ✅ **v2.32.4 — had to install, see §3** |
| PostgreSQL 16 | container up, accepting connections | ✅ |
| **PostGIS 3.4** | `SELECT postgis_version()` | ✅ `USE_GEOS=1 USE_PROJ=1` |
| Redis 7 | container up | ✅ |
| **Redis GEO** | `GEOADD` + `GEOSEARCH BYRADIUS 3km` on Accra coords | ✅ returned rider1 |
| **Redis atomic claim** | two `SET ... NX` on same key | ✅ 1st `OK`, 2nd `nil` |
| RabbitMQ 3 | container up | ✅ |
| Multi-container orchestration | 3 services concurrently + 4th standalone | ✅ ~654 MB RAM used |

## 2. Sprint-1 exit criteria proven *today*

Two of the plan's critical tests were run for real against Postgres 16.

### `ledger.spec` — balanced-transaction constraint (closes issue #1)

Deferred constraint trigger asserting `SUM(debits) = SUM(credits)` per transaction:

- **Balanced settlement** (8150 debit = 5950 + 800 + 1400 credit) → `COMMIT`, 4 rows persisted ✅
- **The PDF §7 figures** (8150 debit vs 4250 + 800 + 1050 = 6100 credit) →
  ```
  ERROR: UNBALANCED tx 2 : debits=8150 credits=6100
  ```
  Transaction rolled back, row count unchanged at 4 ✅

**The database now physically refuses to record the error that was in the original spec.** Issue #1 is closed at the storage layer, not in prose.

### `dispatch.spec` — atomic claim primitive (closes issue #7 mechanism)

`SET assign:1:winner riderA NX PX 30000` → `OK`; same key for `riderB` → `nil`.
The first-to-accept race has a working primitive. Full 50-concurrent-rider test lands in Sprint 8.

---

## 3. Gaps found & fixed

| Gap | Impact | Resolution |
|---|---|---|
| **Docker Compose plugin missing** | Whole dev stack unrunnable | Installed v2.32.4 to `/usr/libexec/docker/cli-plugins/`. **Added to `bootstrap.sh`** |
| **`.git` config stripped from snapshots** | Repo lost its remote between sessions | Expected — credential paths are excluded by design. `bootstrap.sh` re-adds the remote; auth needs a token from you |
| Docker daemon not a service | No containers after restart | `sudo dockerd &` in `bootstrap.sh` |

---

## 4. Standing constraints (unchanged, plan already accounts for these)

| Constraint | Detail | Mitigation |
|---|---|---|
| **RAM ≈ 2 GB** | Ran 4 containers at ~654 MB. Full 15-service stack will **not** run at once | Compose profiles — run only the services under test. CI/staging for full-stack E2E |
| **Android APK** | Gradle needs more RAM than available | GitHub Actions |
| **iOS IPA** | Needs macOS | Codemagic / GH macOS runner |
| **Non-persistent paths** | `/opt/flutter`, Docker images, `node_modules` excluded from snapshots | `infra/scripts/bootstrap.sh` restores all in one command |
| **Disk 16 GB free** | Fine now; 15 service images + Flutter will pressure it | Prune policy; alpine/distroless bases |

---

## 5. Procurement — still outstanding (blocks specific sprints, not Sprint 1)

| Item | Blocks | Note |
|---|---|---|
| GitHub token / push access | Sprint 1 push | Only thing needed to persist work to the repo |
| Hubtel account + **sender ID** | Sprint 2 | Sender IDs need pre-approval — **start now**, this silently blocks OTP |
| Google Cloud billing + Maps keys | Sprint 3 | |
| Paystack test keys | Sprint 6 | |
| Firebase project (FCM/APNs) | Sprint 11 | |
| Paystack live keys | Sprint 17 | |
| Apple Developer + Play Console | Sprint 16 | |

---

## 6. Conclusion

The toolchain is complete and the two highest-risk architectural claims in the master plan — the ledger invariant and the dispatch atomic claim — are **empirically proven on this machine**.

Nothing blocks Sprint 1 except a GitHub token for pushing.
