# OutputLayer — Design Decisions

## Overview

This document explains the reasoning behind OutputLayer's key technical decisions. Each section covers what was chosen, what alternatives were considered, and why.

## Why Idempotency Is Required

Uploads require an `Idempotency-Key` header. Requests without it are rejected.

**Why not optional?** If idempotency is optional, agents that forget the header create duplicates on retry. Making it required means every upload is safe to retry from the first request, without the agent developer needing to opt in.

**How it works:** The server stores the idempotency key with the output record. A second request with the same key and same account returns the original response. A second request with the same key but different payload returns `409 idempotency_conflict`.

**Concurrency:** When multiple concurrent requests arrive with the same idempotency key, exactly one succeeds (201). The others receive `503 in_flight`, indicating the original request is still being processed. The agent can retry after a short delay.

## Why agent_contract Exists

Every response — success, error, and terminal state — includes a structured `agent_contract` field.

**The problem it solves:** Agents cannot reliably parse error messages. A human reads "Rate limit exceeded, try again in 3600 seconds" and understands. An agent needs `retryable: true` and `retry_after_seconds: 3600`.

**Why not just HTTP status codes?** Status codes indicate the category of result but not the recovery action. A 429 tells the agent it was rate limited, but not whether to retry, upgrade, or stop. `agent_contract.next_actions` provides the specific action with method and endpoint.

**Versioning:** The contract includes a `version` field (currently `"1"`). New fields may be added without a version bump. Removal or renaming of existing fields requires a new version and a `/v2/` route.

## Why Artifacts Expire

All artifacts have a TTL. The default is 7 days. Custom expiration can be set at upload time.

**Why not permanent by default?** Agent-generated artifacts are typically transient — reports, intermediate results, exported datasets. Permanent storage by default leads to unbounded growth. Most agent developers would need to build cleanup logic. Automatic expiration makes the common case safe by default.

**Why 7 days?** Long enough for a human to download or share the artifact. Short enough that forgotten artifacts don't accumulate indefinitely. Custom TTLs allow longer retention when needed.

**What happens after expiry:** The output returns `410 output_expired` with `agent_contract.content_accessible: false`. The storage accounting is reclaimed. The metadata record is retained for auditability.

## Why Public and Private Modes Exist

Artifacts are private by default. Setting `"public": true` at upload time generates a CDN URL.

**Why private by default?** Agents often process user data or generate intermediate artifacts that should not be publicly accessible. A default-private policy prevents accidental exposure. The agent must explicitly opt in to public access.

**Why a CDN for public artifacts?** Public artifacts are served from Cloudflare CDN, which provides fast global delivery without routing through the API server. This reduces latency for end users consuming shared artifacts and reduces load on the API server.

**Why not presigned URLs?** Presigned URLs expire and require regeneration. A CDN URL is stable for the lifetime of the artifact. For agent pipelines that return a URL to a user, a stable URL is simpler to manage.

## Why Registration Is Unauthenticated

`POST /v1/keys/register` requires no authentication and no request body.

**Why?** The primary consumer is an autonomous agent that needs API access. Requiring email verification, OAuth, or account creation introduces steps that agents cannot easily perform. A single POST with no prerequisites gets the agent operational immediately.

**Security trade-off:** Unauthenticated registration means anyone can create keys. This is mitigated by aggressive rate limiting on the registration endpoint and by the free tier's limited quota (5 uploads, 250 MB). Abuse is bounded by design.

## Why Billing Uses Row-Level Locking

The billing transaction uses `SELECT ... FOR UPDATE` on the account row to serialize concurrent uploads.

**The problem:** Two concurrent uploads from the same account could both read the same credit balance, both succeed, and both deduct — resulting in a double-spend.

**Why not optimistic locking?** Optimistic locking (check-and-retry) adds complexity to the upload path and can fail repeatedly under sustained concurrency. `FOR UPDATE` serializes the critical section at the database level, which is simpler to reason about and guarantees correctness.

**Performance impact:** The lock is held only for the duration of the billing transaction (credit deduction + output record insert), not for the entire upload. At observed throughput levels (>1,000 req/s per account on local testing), lock contention was not a bottleneck.

## Why Plan Limits Are Code Constants

Plan tier definitions (`PLAN_LIMITS`) are stored as a TypeScript constant, not in a database table.

**Why not a database catalog?** There are four tiers. A catalog table adds a join on every authenticated request, a cache layer for performance, and a migration dependency for limit changes. A code constant is versioned in git, available at zero I/O cost, and testable.

**When this changes:** If custom enterprise tiers or dynamic plan creation are needed, a catalog table would be appropriate. Building it now would be premature.

## Why the Global Safety Ceiling Exists

A hard 50 MB upload ceiling is enforced by `ByteCounter` regardless of plan tier configuration.

**Why?** Plan limits are configurable and could be misconfigured. The global ceiling prevents a configuration error from allowing unbounded uploads. It acts as a final safety net independent of plan logic.

**How it interacts with plans:** `Math.min(planLimit, globalCeiling)` is always used. No plan tier can exceed the ceiling without a deliberate code change to raise it.
