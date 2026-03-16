# OutputLayer — Concurrency Model

## Overview

OutputLayer handles concurrent requests from multiple agents and accounts simultaneously. This document describes how correctness is maintained under concurrency for the critical operations: uploads, idempotency, billing, and storage accounting.

## Upload Concurrency

Multiple agents can upload artifacts concurrently. Each upload is independent as long as it uses a unique idempotency key. The API server processes uploads as streaming operations — content flows from the client through a byte counter and into object storage without buffering the entire file in memory.

Concurrent uploads from different accounts are fully parallel. Concurrent uploads from the same account serialize at the billing transaction level (see below).

## Idempotency Under Concurrency

When multiple concurrent requests arrive with the same `Idempotency-Key` for the same account, the system guarantees exactly-once execution:

| Scenario | Result |
|----------|--------|
| First request arrives | Processed normally → 201 |
| Concurrent duplicate (first still in progress) | Returns 503 `in_flight` |
| Duplicate after first completes | Returns original 201 response |
| Same key, different payload | Returns 409 `idempotency_conflict` |

**How it works:** The idempotency key is checked within the billing transaction. The `FOR UPDATE` lock on the account row serializes concurrent requests from the same account, preventing two requests with the same key from both passing the uniqueness check.

**Validated behavior:** A 10-way concurrent test with the same idempotency key produced exactly one 201 and nine 503 responses. Zero duplicate artifacts were created.

## Billing Concurrency

The billing transaction is the serialization point for same-account concurrency:

```
BEGIN
  SELECT ... FROM accounts WHERE api_key_id = $1 FOR UPDATE
  -- Account row is now locked. Other transactions for this account wait here.
  Check free_remaining and credits_remaining
  Deduct one credit (or one free upload)
  INSERT output record
  UPDATE storage_bytes_used
COMMIT
-- Lock released. Next waiting transaction proceeds.
```

**Why this works:** `FOR UPDATE` acquires a row-level lock that blocks other transactions attempting to lock the same row. This prevents double-spend (two uploads both reading the same balance and both succeeding) without application-level locking.

**Scope of the lock:** The lock is held only for the billing transaction, not for the entire upload. Content is streamed to object storage before the transaction begins. The lock covers only the credit deduction, record insert, and storage accounting update.

**Cross-account parallelism:** Different accounts lock different rows. Uploads from account A never block uploads from account B.

## Storage Accounting Concurrency

Storage usage (`storage_bytes_used`) is updated within the same billing transaction that creates the output record. This guarantees that:

- An output exists if and only if its storage is accounted for
- Storage totals always match the sum of output sizes
- No "phantom" storage consumption from failed uploads

**Validated behavior:** After creating over one million test outputs across multiple concurrent scenarios, every account's `storage_bytes_used` exactly matched `SUM(size_bytes)` of its outputs. Zero drift was detected.

## Rate Limiting Concurrency

Rate limiting uses `express-rate-limit` with in-memory stores. Each plan tier has its own limiter instance. Rate limit checks are not transactional — they use atomic counter increments in memory.

**Known limitation:** The in-memory store is not shared across server instances. If the application scales to multiple instances, rate limits would need to be backed by a shared store (e.g., Redis). For a single-instance deployment, the in-memory store is sufficient.

**Rate limiter resets on restart.** A server restart clears all rate limit counters. This is an accepted trade-off for the simplicity of in-memory storage at the current scale.

## Failure Scenarios

| Scenario | Behavior |
|----------|----------|
| Upload stream fails mid-transfer | No output record created, no billing deducted, no storage consumed |
| Database unavailable during upload | Upload fails with 500, no partial state |
| Object storage unavailable | Upload fails, transaction rolls back, no billing deducted |
| Server crash during transaction | PostgreSQL rolls back uncommitted transaction automatically |
| Concurrent delete + read on same output | Read may return the output or 404, depending on timing. Both are correct. |

## Design Principles

**Serialize where correctness requires it.** Same-account billing is serialized via `FOR UPDATE`. Everything else is parallel.

**No partial state.** An upload either fully succeeds (record created, billing deducted, storage updated, content stored) or fully fails (no record, no deduction, no storage change). There is no intermediate state where billing is deducted but the output doesn't exist.

**Database as coordination layer.** PostgreSQL transactions and row-level locks handle all concurrency coordination. No application-level mutexes, no distributed locks, no message queues. This keeps the concurrency model simple and auditable.
