# OutputLayer — Capacity Validation Summary

**Date:** 2026-03-14
**Phase:** Pre-launch local validation

---

## 1. Introduction

Before public launch, OutputLayer underwent a local capacity validation phase to understand the system's operational limits and validate its behavior under load.

The goals were to:

- Verify correctness under concurrent requests (idempotency, billing, storage accounting)
- Measure single-account and multi-account throughput ceilings
- Confirm resource stability over sustained load (memory, connection pool, event loop)
- Derive safe operational rate limits for each pricing tier

Eight test scenarios were executed using Grafana k6, covering throughput, concurrency, file size impact, connection pool sizing, mixed workload simulation, and a 30-minute soak test.

---

## 2. Test Environment

| Component | Detail |
|-----------|--------|
| Runtime | Node.js 20+ |
| Database | PostgreSQL 16, local instance |
| Connection pool | `pg` pool, tested at 10, 20, and 30 max connections |
| Storage | Local filesystem (`STORAGE_BACKEND=local`) |
| Load tool | Grafana k6 v0.54.0 |

Local filesystem storage was used intentionally to isolate server-side processing performance from object storage network latency. Production deployments use Cloudflare R2, which will add latency proportional to file size. The numbers below represent **server-side processing ceilings**, not end-to-end production latency.

---

## 3. Key Results

| Metric | Value |
|--------|-------|
| Single-account throughput | 1,156 req/s (p95: 33 ms) |
| Multi-account throughput (10 accounts) | 1,293 req/s (p95: 71 ms) |
| Error rate (all scenarios) | 0% |
| Idempotency correctness | 10-way concurrent test passed, 0 duplicates |
| Storage accounting drift | 0 mismatches across >1M outputs |
| Soak test (30 min) heap usage | Stable at 147–166 MB, no upward trend |
| Event loop lag (p99) | 48 ms |
| Optimal PG pool size | 20 connections |

All scenarios completed with 0% server-side error rate. Under sustained 30-minute load, no memory leaks or connection pool exhaustion were observed.

---

## 4. Stability Observations

**Idempotency:** When 10 concurrent virtual users submitted the same idempotency key simultaneously, exactly one upload was accepted (201) and the remaining nine received the expected conflict response (503). Zero duplicate artifacts were created.

**Memory:** Heap usage remained flat at ~155 MB over 30 minutes of continuous uploads. GC fluctuations stayed within a narrow 18 MB band (147–166 MB) with no upward drift.

**Event loop:** Median lag of 31 ms, p99 of 48 ms throughout all scenarios. No evidence of blocking operations.

**Connection pool:** At the default pool size of 10, connection waiting appeared under heavy concurrency (50 VUs). Increasing to 20 connections reduced waiting by 57% and yielded the highest throughput (866 req/s). A pool of 30 showed diminishing returns with slightly higher latency.

**Data integrity:** After all test runs, every account's `storage_bytes_used` matched the sum of its output file sizes. The billing transaction gate (`FOR UPDATE` + `deductUsageInTx`) maintained consistency under all load conditions.

**Row-level billing lock:** The `FOR UPDATE` lock on the `accounts` table did not emerge as a dominant bottleneck during local testing with filesystem storage. The system sustained >1,000 req/s per account without contention. In production, real object storage latency may increase lock hold duration; this should be monitored during staging validation with Cloudflare R2.

---

## 5. Derived Operational Limits

The per-plan upload rate limits were chosen conservatively, well below the observed server-side capacity of >800 req/s:

| Plan | Upload Limit | Capacity Margin |
|------|-------------|-----------------|
| Free | 10 /hour | > 99.99% headroom |
| Basic | 60 /hour | > 99.99% headroom |
| Pro | 120 /hour | > 99.99% headroom |
| Agency | 240 /hour | > 99.99% headroom |

Even with all tiers active simultaneously, aggregate demand remains a negligible fraction of the system's throughput ceiling. At peak, the combined maximum across all plans (430 uploads/hour total) represents less than 0.015% of the observed capacity. These limits are business-level controls, not capacity constraints.

---

## 6. File Size Considerations

Server-side upload processing was measured across file sizes from 1 MB to 100 MB:

| File Size | Server Processing p95 |
|-----------|-----------------------|
| 1 MB | 33 ms |
| 10 MB | 51 ms |
| 25 MB | 51 ms |
| 50 MB | 52 ms |
| 100 MB | 52 ms |

Local filesystem I/O makes file size nearly irrelevant to server-side latency. In production, Cloudflare R2 network latency will dominate upload time for larger files.

The proposed per-plan file size limits are:

| Plan | Max File Size |
|------|--------------|
| Free | 5 MB |
| Basic | 10 MB |
| Pro | 25 MB |
| Agency | 50 MB |

These limits will be validated against real object storage during staging tests before they are finalized.

---

## 7. Conclusion

The OutputLayer API handled high request volumes locally with zero errors and zero data integrity issues across all test scenarios. Idempotency, billing, and storage accounting guarantees held under concurrent load. Memory and connection pool behavior remained stable over a 30-minute sustained test.

The operational rate limits are conservative — set at a small fraction of the system's observed capacity. File size limits are based on server-side measurements and will be refined with production object storage latency data during staging validation.

Overall, the validation results indicate that the OutputLayer API core can sustain request volumes far above the operational limits defined for the initial pricing tiers.

A full internal engineering report with detailed per-scenario breakdowns, bottleneck analysis, and infrastructure recommendations is maintained separately.

---

*Capacity validation performed 2026-03-14. Staging validation with Cloudflare R2 is planned before public launch.*
