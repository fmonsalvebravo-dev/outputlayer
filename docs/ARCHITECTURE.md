# OutputLayer — Architecture

## High-Level Architecture

OutputLayer is a REST API that accepts agent-generated artifacts, stores them in object storage, serves them via CDN or authenticated stream, and expires them automatically.

```
┌─────────────┐      ┌─────────────────┐      ┌──────────────┐
│  AI Agent    │─────▶│  API Server     │─────▶│  PostgreSQL  │
│  (client)    │◀─────│  (Express/Node) │◀─────│  (metadata)  │
└─────────────┘      └────────┬────────┘      └──────────────┘
                              │
                     ┌────────┴────────┐
                     │                 │
               ┌─────▼─────┐   ┌──────▼──────┐
               │ Cloudflare │   │ Cloudflare  │
               │ R2 (store) │   │ CDN (serve) │
               └───────────┘   └─────────────┘
```

**API Server** — Express application handling authentication, upload processing, metadata operations, billing, and agent contract generation. Single-process, stateless except for in-memory rate limiter state.

**PostgreSQL** — Stores all metadata: API keys, account state, output records, idempotency keys, billing data, and storage accounting. The database is the source of truth for artifact lifecycle state.

**Cloudflare R2** — Object storage for artifact content. Artifacts are stored as opaque blobs keyed by output ID. The API server streams content to and from R2.

**Cloudflare CDN** — Serves public artifacts directly. When an artifact is marked public, its CDN URL is returned to the client. Private artifacts are served through the API server via authenticated streaming.

## Request Flow

### Upload (POST /v1/outputs)

```
Agent ──▶ Auth middleware (API key validation)
       ──▶ Rate limiter (plan-aware)
       ──▶ Idempotency check (DB lookup)
       ──▶ Content-Length / file size validation (plan-aware)
       ──▶ Stream to R2 via ByteCounter (enforces size ceiling)
       ──▶ Create output record in transaction:
            BEGIN
              SELECT ... FROM accounts FOR UPDATE  (billing lock)
              Deduct credits / free uploads
              INSERT output record
            COMMIT
       ──▶ Return output metadata + agent_contract
```

### Retrieval (GET /v1/outputs/:id)

```
Agent ──▶ Auth middleware
       ──▶ DB lookup (output record + ownership check)
       ──▶ Return metadata + agent_contract
```

### Content Access (GET /v1/outputs/:id/content)

```
Agent ──▶ Auth middleware
       ──▶ DB lookup + ownership check
       ──▶ If public: 302 redirect to CDN URL
       ──▶ If private: stream content from R2 to client
```

## Artifact Lifecycle

Every artifact follows a deterministic state progression:

```
uploading ──▶ ready ──▶ expired
                │
                ▼
             deleted
```

| State | Meaning |
|-------|---------|
| `uploading` | Upload in progress, not yet committed |
| `ready` | Content stored, accessible via API |
| `expired` | TTL elapsed, content no longer accessible |
| `deleted` | Explicitly deleted by the owner |

Expiration is handled by a background job that runs periodically, marking expired outputs and reclaiming storage accounting.

## Billing Model

Each account has:

- `free_remaining` — initial free upload quota (default: 5)
- `credits_remaining` — purchased credits
- `storage_bytes_used` — current storage consumption
- `storage_bytes_limit` — maximum storage allowed

Uploads consume one credit (or one free upload). The billing transaction uses `SELECT ... FOR UPDATE` on the account row to serialize concurrent uploads from the same account, preventing double-spend.

Storage accounting is updated transactionally — the output's `size_bytes` is added to `storage_bytes_used` in the same transaction that creates the output record.

## Agent Contract

Every API response includes an `agent_contract` field:

```json
{
  "agent_contract": {
    "version": "1",
    "content_accessible": true,
    "safe_to_share": false,
    "retryable": false,
    "expires_in_seconds": 604800,
    "next_actions": [
      {
        "action": "download_content",
        "method": "GET",
        "endpoint": "/v1/outputs/out_01.../content"
      }
    ]
  }
}
```

The contract provides machine-readable guidance so agents can determine their next action without parsing error messages or status text.

## Plan Tiers

Upload rate limits and file size limits are determined by the account's plan tier:

| Tier | Uploads/hour | Max file size |
|------|-------------|---------------|
| free | 10 | 5 MB |
| basic | 60 | 10 MB |
| pro | 120 | 25 MB |
| agency | 240 | 50 MB |

Plan limits are enforced at the middleware level. A global safety ceiling of 50 MB applies regardless of plan tier.

## Discovery

Agents can discover OutputLayer's capabilities through multiple surfaces:

| Endpoint | Purpose |
|----------|---------|
| `/.well-known/agent.json` | Agent capability manifest |
| `/v1/tool` | Machine-readable tool definition |
| `/v1/schema` | OpenAPI 3.0 specification |
| `/v1/capabilities` | Current limits, plan tiers, quota |
| `/v1/examples` | Code examples for common operations |
| `/AGENTS.md` | Full agent integration guide |
