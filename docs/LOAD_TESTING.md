# OutputLayer — Load Testing

## Overview

OutputLayer was subjected to a structured capacity validation phase before public launch. Eight test scenarios were executed using Grafana k6 to verify correctness, measure throughput ceilings, and confirm resource stability under sustained load.

This document provides a high-level summary of the approach and findings. For detailed results, see [docs/capacity-validation-summary.md](docs/capacity-validation-summary.md). For methodology details, see [docs/testing-methodology.md](docs/testing-methodology.md).

## Tools

| Tool | Purpose |
|------|---------|
| Grafana k6 | Load generation and scenario orchestration |
| PostgreSQL (local) | Isolated test database |
| Local filesystem storage | Eliminated object storage latency to isolate server-side processing |

## Scenarios Tested

| Scenario | Purpose | Result |
|----------|---------|--------|
| Single-account throughput | Maximum req/s for one account | 1,156 req/s, 0% errors |
| Multi-account throughput | System-wide throughput across 10 accounts | 1,293 req/s, 0% errors |
| File size impact | Upload latency across 1–100 MB files | p95 < 52 ms for all sizes |
| Idempotency concurrency | 10-way concurrent duplicate test | Exactly 1 success, 0 duplicates |
| PG pool sizing | Compare pool=10, 20, 30 under load | Pool=20 optimal |
| Mixed workload | Concurrent uploads, reads, deletes | 0% errors, all checks passed |
| Soak test (30 min) | Memory leaks, pool exhaustion, drift | Stable heap, 0 drift |
| Rate limiter accuracy | Verify rate limits enforce correctly | Confirmed |

## Key Findings

- **Zero server-side errors** across all scenarios.
- **Zero data integrity issues** — no duplicate artifacts, no storage accounting drift, no billing inconsistencies.
- **No memory leaks** — heap usage remained flat at ~155 MB over 30 minutes of sustained load.
- **Connection pool optimized** — pool size of 20 provided the best throughput-to-resource ratio.
- **Rate limits have large headroom** — the most aggressive plan (240/hour) uses less than 0.01% of observed server-side capacity.

## Correctness Verification

After each test run, automated SQL checks verified:

- Zero duplicate idempotency keys per account
- Zero storage accounting drift (recorded usage matches actual file sizes)
- Correct output counts matching expected request volumes

These checks confirm that the billing and storage logic maintained correctness under load, not just that HTTP status codes were correct.

## Environment Note

All tests used local filesystem storage to isolate server-side processing from object storage network latency. The reported throughput and latency numbers represent **server-side ceilings**. Production performance depends on Cloudflare R2 upload latency and network conditions.

Staging validation with production object storage is planned as a follow-up.

## Running the Load Tests

The test suite is in the `load-tests/` directory:

```
load-tests/
  config.js            # Shared configuration
  scenario-01-*.js     # Single-account throughput
  scenario-02-*.js     # Multi-account throughput
  scenario-03-*.js     # File size impact
  ...
  scripts/             # Fixture generation and helpers
```

Tests require a running API server, a local PostgreSQL instance, and k6 installed. See `load-tests/config.js` for environment variable configuration.
