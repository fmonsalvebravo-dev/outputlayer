# OutputLayer — Protocol

## Overview

This document describes the OutputLayer protocol: the HTTP interface, request/response shapes, lifecycle states, error semantics, and discovery mechanisms. It is intended as a reference for agents and client implementations.

## Authentication

All operations except registration and discovery require a Bearer token:

```
Authorization: Bearer ol_live_{64 hex chars}
```

Keys are obtained via `POST /v1/keys/register` (no authentication required). The key is returned once and never stored in plaintext by the server.

## Core Operations

### Register

```
POST /v1/keys/register
Content-Type: application/json
Body: {}
```

Returns:

```json
{
  "apiKey": "ol_live_...",
  "accountId": "key_01..."
}
```

### Upload

```
POST /v1/outputs
Authorization: Bearer {key}
Idempotency-Key: {unique string}
Content-Type: application/json

{
  "mimeType": "application/pdf",
  "label": "report.pdf",
  "content": "{base64-encoded content}",
  "public": false,
  "expiresAt": "2026-03-20T00:00:00Z"
}
```

Or as multipart:

```
POST /v1/outputs
Authorization: Bearer {key}
Idempotency-Key: {unique string}
Content-Type: multipart/form-data

Fields: mimeType, label, public, expiresAt
File part: content (the binary file)
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `mimeType` | Yes | — | MIME type of the artifact |
| `label` | No | — | Human-readable filename |
| `content` | Yes | — | Base64 string (JSON) or file part (multipart) |
| `public` | No | `false` | Whether to generate a CDN URL |
| `expiresAt` | No | 7 days from now | ISO 8601 expiration timestamp |

### Retrieve Metadata

```
GET /v1/outputs/{outputId}
Authorization: Bearer {key}
```

### Download Content

```
GET /v1/outputs/{outputId}/content
Authorization: Bearer {key}
```

For public artifacts: returns `302` redirect to CDN URL.
For private artifacts: streams content directly with appropriate `Content-Type`.

### List Outputs

```
GET /v1/outputs
Authorization: Bearer {key}
```

Returns paginated list of outputs owned by the authenticated account.

### Delete

```
DELETE /v1/outputs/{outputId}
Authorization: Bearer {key}
```

## Artifact States

| State | Description | Content accessible |
|-------|-------------|-------------------|
| `uploading` | Upload in progress | No |
| `ready` | Content stored and available | Yes |
| `expired` | TTL elapsed | No |
| `deleted` | Explicitly removed by owner | No |

State transitions are one-directional: `uploading → ready → expired` or `ready → deleted`.

## Agent Contract

Every response includes `agent_contract`:

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Contract version (currently `"1"`) |
| `content_accessible` | boolean | Whether artifact content can be downloaded now |
| `safe_to_share` | boolean | Whether a public URL exists |
| `retryable` | boolean | Whether the same request can be retried safely |
| `expires_in_seconds` | number or null | Time until expiration |
| `next_actions` | array | Ordered list of available actions |

Each action in `next_actions`:

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Action identifier |
| `available` | boolean | Whether the action can be performed now |
| `recommended` | boolean | Whether this is the suggested next step |
| `method` | string | HTTP method |
| `endpoint` | string | API path |
| `description` | string | Human-readable explanation |

## Error Semantics

| Status | Error code | Meaning | agent_contract action |
|--------|-----------|---------|----------------------|
| 400 | `payload_too_large` | File exceeds plan limit | `upgrade_plan` |
| 400 | `invalid_request` | Malformed request | — |
| 401 | `missing_api_key` | No Authorization header | `register_key` |
| 401 | `invalid_api_key` | Key not recognized | `register_key` |
| 402 | `quota_exhausted` | No credits remaining | `buy_credits` |
| 405 | `wrong_method` | Incorrect HTTP method | Correct method provided |
| 409 | `idempotency_conflict` | Same key, different payload | — |
| 410 | `output_expired` | Artifact has expired | — |
| 429 | `rate_limited` | Plan rate limit exceeded | `retry_after_wait` |
| 503 | `in_flight` | Concurrent idempotent request | `retry_after_wait` |

All error responses include `agent_contract` with appropriate recovery guidance.

## Idempotency

`Idempotency-Key` is required on `POST /v1/outputs`. Behavior:

- First request with a given key: processed normally
- Repeat with same key + same account: returns original response
- Repeat with same key + different payload: `409 idempotency_conflict`
- Concurrent duplicate while first is in progress: `503 in_flight`

Keys are scoped to the authenticated account. Different accounts can use the same key independently.

## Quota Headers

Every authenticated response includes quota headers:

```
X-OutputLayer-Free-Remaining: 4
X-OutputLayer-Credits-Remaining: 0
X-OutputLayer-Storage-Used-Bytes: 18432
X-OutputLayer-Storage-Limit-Bytes: 262144000
```

## Rate Limit Headers

Upload responses include standard rate limit headers:

```
RateLimit-Limit: 10
RateLimit-Remaining: 8
RateLimit-Reset: 1710547200
```

## Discovery

| Endpoint | Content-Type | Description |
|----------|-------------|-------------|
| `/.well-known/agent.json` | application/json | Agent capability manifest |
| `/v1/tool` | application/json | Machine-readable tool definition |
| `/v1/schema` | application/json | OpenAPI 3.0 specification |
| `/v1/capabilities` | application/json | Limits, tiers, quota, pricing |
| `/v1/examples` | application/json | Code examples |
| `/AGENTS.md` | text/markdown | Full integration guide |

Discovery endpoints are unauthenticated. `/v1/capabilities` returns plan-specific limits when an Authorization header is present.

## Versioning

The current API version is V1 (`/v1/`). The versioning policy:

- New response fields may be added without a version change (non-breaking)
- Existing fields will not be removed or renamed within a version
- Breaking changes require a new version (`/v2/`) with a minimum 6-month deprecation period for the previous version
