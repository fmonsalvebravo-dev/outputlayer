# OutputLayer — Operations

## Overview

This document describes OutputLayer's operational behavior: how artifacts move through their lifecycle, how resources are managed, and how the system maintains health over time.

## Artifact Lifecycle

### Upload

1. Client sends `POST /v1/outputs` with content and metadata.
2. Server validates authentication, rate limits, idempotency, and file size.
3. Content is streamed to object storage.
4. A billing transaction deducts one credit, creates the output record, and updates storage accounting.
5. Server returns output metadata with `status: "ready"` and `agent_contract`.

If any step fails, the transaction rolls back. No partial artifacts are created.

### Access

- **Private artifacts** are served via `GET /v1/outputs/:id/content` with authentication. The server streams content from object storage to the client.
- **Public artifacts** are served from Cloudflare CDN. The content endpoint returns a `302` redirect to the CDN URL.

### Expiration

All artifacts have a TTL (default: 7 days). A background job periodically checks for expired outputs and:

1. Marks the output as `expired`
2. Reclaims storage accounting on the owner's account
3. Removes content from object storage

After expiration, metadata queries return `410 output_expired`.

### Deletion

Owners can delete artifacts before expiration via `DELETE /v1/outputs/:id`. The behavior is the same as expiration: content is removed, storage is reclaimed, and the metadata record is marked `deleted`.

## Storage Growth Controls

Storage consumption is bounded by multiple mechanisms:

| Control | Scope | Mechanism |
|---------|-------|-----------|
| Storage limit | Per account | `storage_bytes_limit` checked before each upload |
| File size limit | Per plan tier | Enforced by ByteCounter stream |
| Global ceiling | System-wide | 50 MB hard maximum regardless of plan |
| Automatic expiration | Per artifact | TTL-based cleanup |
| Credit/quota system | Per account | Uploads consume credits; zero credits = no uploads |

These controls work together to prevent unbounded storage growth without requiring manual cleanup from account owners.

## Rate Limiting

Rate limits are enforced per account at the middleware level. Different endpoint categories have independent limits:

| Category | Scope | Purpose |
|----------|-------|---------|
| Upload | Per plan tier | Controls artifact creation rate |
| Read | Per account | Prevents excessive metadata/content retrieval |
| Delete | Per account | Prevents bulk deletion abuse |
| Registration | Per IP | Prevents key registration abuse |

Upload rate limits are plan-aware (free: 10/hr, basic: 60/hr, pro: 120/hr, agency: 240/hr). Other endpoint limits are uniform across plans.

Standard `RateLimit-*` headers are included on every response so agents can track their remaining quota.

## Health Monitoring

The `/health` endpoint returns the server's operational status:

```json
{
  "status": "ok"
}
```

When internal metrics are enabled, `/internal/metrics` provides additional diagnostics:

- Node.js heap usage and RSS
- PostgreSQL connection pool statistics (total, idle, waiting)
- Event loop lag

These metrics are gated behind an environment flag and are not exposed by default.

## Plan Tier Behavior

Each account has a `plan_tier` that determines upload rate limits and file size limits. Plans are assigned at registration (default: `free`) and upgraded when credit packs are purchased.

| Tier | Uploads/hour | Max file size | Storage limit |
|------|-------------|---------------|---------------|
| free | 10 | 5 MB | 250 MB |
| basic | 60 | 10 MB | 2 GB |
| pro | 120 | 25 MB | 10 GB |
| agency | 240 | 50 MB | 50 GB |

Plan enforcement is gated behind a feature flag (`ENABLE_PLAN_ENFORCEMENT`). When the flag is off, legacy limits apply (60 uploads/hour, 25 MB max file size). This allows safe rollout and instant rollback.

## Quota Headers

Every authenticated response includes headers showing the account's current resource usage:

```
X-OutputLayer-Free-Remaining: 4
X-OutputLayer-Credits-Remaining: 0
X-OutputLayer-Storage-Used-Bytes: 18432
X-OutputLayer-Storage-Limit-Bytes: 262144000
```

Agents can read these headers to make proactive decisions about resource usage without making separate API calls.
