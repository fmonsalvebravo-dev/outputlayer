# OutputLayer — Testing Methodology

**Phase:** Pre-launch validation

---

## Purpose

Before public launch, OutputLayer was subjected to a structured capacity validation process. The goal was to understand the system's operational limits, verify correctness guarantees under concurrent load, and derive safe rate limits for the initial pricing tiers.

This document describes the methods used. For results, see [capacity-validation-summary.md](capacity-validation-summary.md). For a developer-oriented interpretation, see [validation-results-overview.md](validation-results-overview.md).

---

## Tools

| Tool | Role |
|------|------|
| Grafana k6 | Load generation, scenario orchestration, metric collection |
| PostgreSQL (local) | Isolated database instance for test workloads |
| Local filesystem storage | Substituted for object storage to isolate server-side processing |
| curl | Manual verification of individual endpoints |
| SQL queries | Post-test correctness checks (idempotency, storage accounting) |

---

## Test Categories

### 1. Throughput measurement

Sustained request volume at constant rate to determine the server-side processing ceiling for both single-account and multi-account workloads. These tests used small payloads to isolate request handling from I/O.

### 2. Concurrency correctness

Concurrent requests targeting the same resources (same idempotency key, same account billing row) to verify that transactional guarantees hold under contention. The system was expected to produce exactly one successful result per idempotency key, with no duplicate artifacts and no accounting drift.

### 3. File size impact

Uploads ranging from 1 MB to 100 MB to measure how file size affects server-side processing latency. Local filesystem storage was used intentionally — this isolates the server's multipart parsing, stream handling, and transaction overhead from network transfer time.

### 4. Resource stability

A 30-minute sustained load test (soak test) to detect memory leaks, connection pool exhaustion, or event loop degradation over time. Heap usage, pool statistics, and event loop lag were sampled throughout.

### 5. Connection pool sizing

Identical workloads run against three different PostgreSQL connection pool sizes (10, 20, 30) to determine the optimal configuration. Metrics included throughput, latency percentiles, and pool wait queue depth.

### 6. Mixed workload simulation

Concurrent uploads, reads, and deletes at realistic ratios to verify that different operation types do not interfere with each other under shared load.

### 7. Plan-tier rollout verification

After implementing per-plan rate limits and file size enforcement, production endpoints were tested to confirm that the feature flag gating worked correctly, that legacy behavior was preserved when enforcement was off, and that tier-specific limits applied when enforcement was enabled.

---

## Environment Isolation

All load tests ran against a local instance of the API with local PostgreSQL and filesystem storage. This was a deliberate choice:

- **Local storage** eliminates network variability, producing repeatable measurements of server-side processing time.
- **Local database** avoids shared-resource contention that could skew results.
- **No production traffic** during testing — results reflect controlled conditions only.

The trade-off is that these results do not include object storage latency (Cloudflare R2) or network round-trip time. Production latency for file uploads will be higher. The validation establishes server-side ceilings, not end-to-end production latency.

---

## Post-Test Verification

After each test run, automated SQL checks verified:

- **Zero duplicate idempotency keys** per account
- **Zero storage accounting drift** — every account's recorded `storage_bytes_used` matched the actual sum of its output file sizes
- **Correct output counts** — the number of created outputs matched the expected request volume

These checks confirm that the billing and storage accounting logic maintained correctness under load, not just that HTTP status codes were correct.

---

## What This Methodology Does Not Claim

- It does not measure production latency under real network conditions.
- It does not simulate geographic distribution or CDN behavior.
- It does not test horizontal scaling (single-instance only).
- It does not cover all possible failure modes (disk full, OOM, network partition).
- File size latency results are not transferable to production without staging validation against real object storage.

These are acknowledged limitations. Staging validation with production infrastructure is a planned follow-up.

---

*Methodology documented 2026-03-14.*
