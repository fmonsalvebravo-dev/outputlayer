# OutputLayer — Reliability

## Idempotency Guarantees

Every upload requires an `Idempotency-Key` header. The system guarantees:

- **Exactly-once execution** per key per account. A repeated request returns the original response without creating a duplicate.
- **Conflict detection.** The same key with a different payload returns `409 idempotency_conflict`.
- **Concurrent safety.** If two requests with the same key arrive simultaneously, one succeeds and the others receive `503 in_flight`.
- **Validated.** 10-way concurrent tests produced exactly one artifact per key with zero duplicates.

## Billing Consistency

Upload billing is transactional:

- Credit deduction, output record creation, and storage accounting happen in a single database transaction.
- If any step fails, the entire transaction rolls back. No partial state is possible.
- Concurrent uploads from the same account are serialized via row-level locking to prevent double-spend.

**Validated.** After over one million test uploads, zero billing inconsistencies were detected.

## Storage Accounting

Every account's `storage_bytes_used` is updated in the same transaction that creates the output record. This guarantees:

- Storage totals always match the actual sum of output sizes.
- Failed uploads do not consume storage quota.
- Deleted and expired outputs reclaim their storage.

**Validated.** Post-test SQL checks confirmed zero accounting drift across all test scenarios.

## Artifact Lifecycle

Artifacts follow a deterministic lifecycle with no ambiguous states:

| Transition | Trigger | Reversible |
|-----------|---------|------------|
| `uploading → ready` | Upload completes | No |
| `ready → expired` | TTL elapses | No |
| `ready → deleted` | Owner deletes | No |

Failed uploads leave no partial records. Expiration is handled by a background job.

## Rate Limiting

Upload rate limits are enforced per account based on plan tier:

| Tier | Limit |
|------|-------|
| free | 10 /hour |
| basic | 60 /hour |
| pro | 120 /hour |
| agency | 240 /hour |

When a rate limit is exceeded, the response includes `429` with `Retry-After` header and `agent_contract` guidance.

**Known limitation.** Rate limit state is in-memory and resets on server restart. This is acceptable for a single-instance deployment. Multi-instance scaling would require a shared rate limit store.

## File Size Enforcement

Upload size is enforced at two levels:

1. **Content-Length check** — for JSON uploads, the declared Content-Length is checked against the plan's file size limit before reading the body.
2. **ByteCounter stream** — for all uploads, a transform stream counts bytes in flight and aborts if the plan limit or the global 50 MB ceiling is exceeded.

This two-layer approach rejects oversized uploads as early as possible while still enforcing limits on streaming uploads where Content-Length may not be accurate.

## Error Recovery

Every error response includes `agent_contract` with machine-readable recovery guidance. Agents can programmatically determine whether to retry, wait, upgrade, or stop.

| Failure | Recovery |
|---------|----------|
| Rate limited | Wait and retry (seconds provided) |
| Quota exhausted | Purchase credits |
| File too large | Upgrade plan or reduce file size |
| Concurrent duplicate | Retry after short delay |
| Expired artifact | No recovery (artifact is gone) |

## What Is Not Guaranteed

- **End-to-end latency.** Server-side processing is validated, but production latency depends on object storage and network conditions.
- **Multi-instance consistency.** Rate limits and idempotency-in-flight detection assume a single server instance. Multi-instance requires additional coordination.
- **Indefinite retention.** All artifacts expire. There is no permanent storage tier.
