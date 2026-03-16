# OutputLayer — Validation Results Overview

**Audience:** Developers evaluating OutputLayer for agent integration

---

## What Was Validated

OutputLayer's API was tested across eight scenarios before public launch. The validation covered four areas that matter most when integrating a storage API into an agent pipeline:

1. **Correctness** — Does the system produce the right results under concurrent load?
2. **Throughput** — How much traffic can the server handle?
3. **Stability** — Does the system degrade over sustained use?
4. **Operational limits** — Are the published rate limits reasonable relative to actual capacity?

For detailed numbers, see [docs/CAPACITY_VALIDATION_SUMMARY.md](docs/CAPACITY_VALIDATION_SUMMARY.md). For testing methods, see [docs/TESTING_METHODOLOGY.md](docs/TESTING_METHODOLOGY.md).

---

## What Developers Can Rely On

### Idempotency works under concurrency

When 10 concurrent requests submitted the same idempotency key, exactly one upload succeeded. The remaining nine received the expected conflict response. Zero duplicate artifacts were created across all test runs.

**What this means for agents:** Retry logic using `Idempotency-Key` is safe. An agent that retries a failed upload with the same key will not create duplicates, even under concurrent execution.

### Storage accounting is accurate

After creating over one million test outputs, every account's recorded storage usage exactly matched the actual sum of its output file sizes. No drift was detected.

**What this means for agents:** Quota headers (`X-OutputLayer-Storage-Used-Bytes`, `X-OutputLayer-Storage-Limit-Bytes`) reflect the true state. Agents can trust these values for capacity planning decisions.

### The system does not degrade over time

A 30-minute sustained load test showed stable memory usage (no upward trend), zero connection pool exhaustion, and consistent latency throughout. No restarts or manual intervention were needed.

**What this means for agents:** Long-running agent pipelines that make steady API calls should not encounter progressive degradation or resource exhaustion on the server side.

### Rate limits have large safety margins

The published per-plan rate limits are a small fraction of the system's observed throughput capacity. Even the most generous plan (Agency at 240 uploads/hour) represents less than 0.01% of the server-side processing ceiling.

**What this means for agents:** Rate limits exist as business controls, not because the server is near capacity. An agent operating within its plan's limits will not experience throttling due to system load.

---

## What Developers Should Keep in Mind

### Local validation, not production benchmarks

All tests used local filesystem storage instead of Cloudflare R2. This means the throughput and latency numbers reflect server-side processing only. In production, upload latency will be higher due to object storage network round-trips, especially for larger files.

The server-side numbers establish a ceiling — actual production performance will be lower but is bounded by this ceiling plus network transfer time.

### File size latency depends on object storage

Server-side processing time was nearly flat across file sizes (1 MB to 100 MB). In production, file size will have a meaningful impact on upload latency because Cloudflare R2 upload time scales with file size. The per-plan file size limits will be refined after staging validation with real object storage.

### Single-instance testing only

The validation tested a single API server instance. Behavior under horizontal scaling (multiple instances) has not been validated. The in-memory rate limiter resets on restart and is not shared across instances — this is a known limitation documented for future work.

---

## Summary

| Area | Status |
|------|--------|
| Idempotency correctness | Verified under concurrency |
| Storage accounting accuracy | Verified across >1M outputs |
| Memory stability (30 min) | No leaks detected |
| Throughput headroom vs rate limits | Large margin (>99.99%) |
| Production latency (with R2) | Pending staging validation |
| Multi-instance behavior | Not yet tested |

The core API logic — uploads, billing, idempotency, and storage accounting — has been validated under controlled load. The published rate limits are conservative. Production latency validation with real object storage is planned as a follow-up.

---

*Overview prepared 2026-03-14. Based on local capacity validation results.*
