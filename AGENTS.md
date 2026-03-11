# OutputLayer — Agent Integration Guide

OutputLayer — Infrastructure for agent artifacts.
Store, retrieve, share, and manage lifecycle for AI-generated artifacts.

This guide covers everything an agent needs to integrate with OutputLayer: authentication, core workflow, idempotency, quota management, expiry semantics, and error handling. For the complete `agent_contract` field reference, see [docs/agent-contract-schema.md](docs/agent-contract-schema.md).

---

## §1 Overview

OutputLayer is a REST API that lets AI agents upload binary artifacts (PDFs, images, JSON, CSV, and more), retrieve them later, optionally share them via public CDN URL, and delete them when done. Every response includes a structured `agent_contract` field that tells the agent exactly what to do next — no message parsing required.

Typical use cases:
- Upload a generated report and return a download link to the user
- Store intermediate artifacts between agent steps
- Share a file publicly via CDN without exposing your API key
- Manage artifact TTLs and delete outputs after use

---

## §2 Authentication

### How to obtain an API key

Send a POST request to `/v1/keys/register`. No authentication is required. The plaintext key is returned exactly once and never stored.

```bash
curl -X POST https://api.outputlayer.dev/v1/keys/register \
  -H "Content-Type: application/json" \
  -d '{"email": "agent@example.com"}'
```

Response:
```json
{
  "apiKey": "ol_live_a3f8c2d...",
  "accountId": "key_01JXXXXX"
}
```

Store `apiKey` securely. It cannot be retrieved again.

### How to send the API key

All protected endpoints require:
```
Authorization: Bearer <api_key>
```

**The `x-api-key` header is not supported.**
**API keys must not appear in query strings** — the server rejects them with 400 `invalid_request`.

Never log the full key value. The `accountId` field is safe to log.

---

## §3 Core Workflow

A complete agent session:

**1. Register** (once, store the key)
```
POST /v1/keys/register
```

**2. Upload**
```bash
curl -X POST https://api.outputlayer.dev/v1/outputs \
  -H "Authorization: Bearer <api_key>" \
  -H "Idempotency-Key: <unique-key>" \
  -F "content=@report.pdf;type=application/pdf" \
  -F "mimeType=application/pdf" \
  -F "label=Q4 Report.pdf"
```

The binary file part **must use the field name `content`**. Optional form fields: `label`, `expiresAt`, `public`, `metadata`.

**3. Retrieve metadata**
```
GET /v1/outputs/<outputId>
Authorization: Bearer <api_key>
```

**4. Stream content**
```
GET /v1/outputs/<outputId>/content
Authorization: Bearer <api_key>
```
Returns raw bytes with the stored MIME type and `Content-Disposition: attachment`.

**5. Delete when done**
```
DELETE /v1/outputs/<outputId>
Authorization: Bearer <api_key>
```
Idempotent. Already-deleted outputs return 200 with `status: "deleted"`.

---

## §4 Idempotency

The `Idempotency-Key` header is **required** on `POST /v1/outputs`. It is not required on any other endpoint.

### How it works
- Two requests with the same key and same payload return the same response (the cached 201)
- Two requests with the same key but different payload return 409 `idempotency_conflict`
- Keys are scoped per API key (different accounts can use the same key string)
- Keys expire after 7 days

### Key generation
Use a stable, unique identifier. For agent jobs: `<job_id>:<attempt_number>` or a UUID v4.

### Retrying failed uploads
If an upload returns `status: "failed"`, the idempotency slot is **released**. The agent can retry with the **same Idempotency-Key** and will receive a fresh upload attempt, not a cached failure.

### Concurrent requests with same key
If two requests arrive simultaneously with the same key, the second receives 503 `idempotency_in_flight` with `Retry-After: 5`. Retry after 5 seconds with the identical key and payload.

---

## §5 Quota and Billing

Every authenticated response includes quota headers:

| Header | Description |
|--------|-------------|
| `X-OutputLayer-Free-Remaining` | Free uploads remaining |
| `X-OutputLayer-Credits-Remaining` | Purchased credits remaining |
| `X-OutputLayer-Storage-Used-Bytes` | Current storage usage |
| `X-OutputLayer-Storage-Limit-Bytes` | Storage cap (250 MB) |

### Quota exhaustion
If both `free_remaining` and `credits_remaining` are 0, the next upload returns 402 `quota_exhausted`. The `agent_contract` recommended action is `buy_credits` pointing to `POST /v1/credits/checkout`.

### Storage limit
If adding the file would exceed the 250 MB storage cap, the server returns 402 `storage_limit_reached`. The `agent_contract` recommended action is `delete_output` (free space first) or `buy_credits` (upgrade plan).

### Credit packs
Start a purchase: `POST /v1/credits/checkout` → returns `purchaseId` and `checkoutUrl`
Poll for confirmation: `GET /v1/credits/verify?purchaseId=<id>`
After confirmation, retry with the same Idempotency-Key.

---

## §6 Expiry and Tombstones

### Setting expiry
Pass `expiresAt` as an ISO 8601 UTC string on upload:
```json
{ "expiresAt": "2026-04-01T00:00:00Z" }
```
Default TTL: 7 days. Maximum: 30 days.

### What happens at expiry
The background job (runs every 5 minutes) sets `status = "expired"`, nulls `contentUrl` and `publicUrl`, and reclaims R2 storage. The database row is **never deleted**.

### 410 vs 404
- **404 `output_not_found`**: This output ID has never existed.
- **410 `output_expired`**: The output existed; content is gone. Create a new output.
- **410 `output_deleted`**: The output was explicitly deleted. Create a new output.

Rows are never purged from the database. An agent receiving 410 for `out_01JXXXXX` will always get 410 for that ID — it will never flip to 404. This allows deterministic agent retry semantics.

### Visibility is set at creation time

Output visibility is determined when the output is created and cannot be changed afterward.

- An output created with `public: false` (the default) will always be private. It cannot be converted to a public CDN-accessible URL later.
- If a public version is needed, create a new output with `public: true`. The original private output is unaffected.
- The `agent_contract` on private outputs includes a `create_public_output` action (always `available: false`) to communicate this constraint explicitly — the agent does not need to infer it from the response shape.

This restriction applies to V1. More flexible visibility controls may be explored in future versions.

---

## §7 Rate Limits

All limits use rolling windows.

| Endpoint | Limit | Window | Key |
|----------|-------|--------|-----|
| `POST /v1/outputs` | 60 | 1 hour | per API key |
| `GET /v1/outputs` | 2000 | 1 hour | per API key |
| `GET /v1/outputs/{id}` | 2000 | 1 hour | per API key |
| `GET /v1/outputs/{id}/content` | 2000 | 1 hour | per API key |
| `DELETE /v1/outputs/{id}` | 200 | 1 hour | per API key |
| Discovery endpoints | 60 | 1 minute | per IP |
| `POST /v1/keys/register` | 10 | 1 hour | per IP |

Rate-limited responses return 429 `rate_limited`. The `agent_contract` includes `retry_after_wait` with a `retry_after_seconds` value.

V1 uses conservative limits to ensure predictable infrastructure usage across all accounts. The free tier is designed for development, evaluation, and moderate integration workloads — not high-throughput production pipelines. Higher or differentiated limits may be introduced in future plans.

---

## §8 Error Handling

### By HTTP status

**400** — Validation error. Fix the request before retrying. The `agent_contract` recommended action is `check_capabilities` pointing to `GET /v1/capabilities`.

**401** — Authentication error. Recommended action is `register_key`. Check that:
- The `Authorization: Bearer <key>` header is present and correctly formatted
- The key starts with `ol_live_`
- The key has not been deactivated

**402** — Quota error. Recommended action is `buy_credits` (quota) or `delete_output` (storage). Do not retry the upload until quota is restored.

**404** — Output not found. Recommended action is `create_new_output`.

**409** — Idempotency conflict. The Idempotency-Key was reused with a different payload. Generate a new key.

**410** — Output expired or deleted. Content is gone permanently for this ID. Recommended action is `create_new_output`.

**422** — Upload failed (transient). `retryable: true`. Retry with the same Idempotency-Key. The slot was released.

**429** — Rate limited. `retryable: true`. Wait `retry_after_seconds` then retry.

**500** — Server error. `retryable: true`. Wait `retry_after_seconds` then retry with the same Idempotency-Key.

**503 (idempotency_in_flight)** — Another request with the same key is in flight. `retryable: true`. Wait 5 seconds then retry with identical key and payload.

### Using agent_contract for decisions

```
response.agent_contract.next_actions
  .find(a => a.recommended)
  .action  →  what to do next
```

No switch on HTTP status needed. The recommended action and its `endpoint` tell the agent exactly where to go.

---

## §9 Discovery Endpoints

These endpoints are public (no auth) and CORS-enabled.

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/capabilities` | Authoritative limits, MIME types, rate limits, pack catalog |
| `GET /v1/schema` | Full OpenAPI 3.1 specification |
| `GET /v1/examples` | Curl, Python, TypeScript code examples |
| `GET /v1/tool` | MCP tool card for agent tool registries |
| `GET /.well-known/agent.json` | Agent discovery |

Agents should poll `GET /v1/capabilities` to verify limits before implementation, not hardcode values from documentation.

---

## §10 See Also

- [docs/agent-contract-schema.md](docs/agent-contract-schema.md) — Complete `agent_contract` schema with all action codes, error codes, and field definitions
- [README.md](README.md) — Quick start and endpoint reference for developers
- [llms.txt](llms.txt) — Compact plaintext version of this guide for LLM context windows
