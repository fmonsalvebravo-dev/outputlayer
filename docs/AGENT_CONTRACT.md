# agent_contract Schema Reference

Every OutputLayer response — success and error — includes an `agent_contract` field. It provides structured, machine-readable guidance on what the agent should do next, without requiring the agent to parse error messages or inspect HTTP status codes.

**Source of truth:** All field names, action codes, and error codes in this document are extracted directly from [agentContract.ts](https://github.com/fmonsalvebravo-dev/outputlayer/blob/main/agentContract.ts). No codes or fields are invented here.

---

## AgentContract Object

Present on every response at the top level as `agent_contract`.

| Field | Type | Description |
|-------|------|-------------|
| `version` | `"1"` | Contract version. Always `"1"` in V1. Changing this is a breaking change. |
| `content_accessible` | `boolean` | `true` only when `status === "ready"`. Indicates the content can be downloaded. |
| `safe_to_share` | `boolean` | `true` only when `publicUrl` is non-null (output created with `public: true`). |
| `retryable` | `boolean` | `true` for transient failures: `upload_failed`, `rate_limited`, `server_error`, `idempotency_in_flight`. |
| `expires_in_seconds` | `number \| null` | Seconds until the output expires. `null` if already expired, deleted, or no expiry set. |
| `next_actions` | `Action[]` | Ordered list of available next actions. Exactly one has `recommended: true`. |
| `migration_note` | `string?` | Present **only** on responses from deprecated endpoints. Never set by the contract builders. |

---

## Action Object

Each element of `next_actions`.

| Field | Type | Description |
|-------|------|-------------|
| `action` | `string` | One of the 11 stable action codes (see below). |
| `available` | `boolean` | Whether this action can currently be taken. |
| `recommended` | `boolean` | Exactly one action per response has `recommended: true`. This is the primary next step. |
| `description` | `string?` | Human- and agent-readable guidance. |
| `method` | `string?` | HTTP method for the endpoint. |
| `endpoint` | `string?` | Relative path (e.g. `/v1/outputs`) or absolute URL (for CDN public URLs). |
| `reason` | `string?` | Only present when `available: false`. Explains why the action is unavailable. |
| `retry_after_seconds` | `number?` | Only on `retry_after_wait` actions. Number of seconds to wait before retrying. |
| `required_body_changes` | `object?` | Only on `create_public_output` when `available: false`. Specifies required field changes. |

---

## 11 Stable Action Codes

These codes are part of the V1 stability guarantee. They will not be renamed or removed in V1. New codes may be added (non-breaking).

| Code | When present | `recommended` |
|------|-------------|--------------|
| `download_content` | Output `status=ready` | Yes (private output), No (public output) |
| `share_public_url` | Output `status=ready` with `publicUrl` set | Yes |
| `delete_output` | Output `status=ready` | No |
| `create_new_output` | `status=expired/deleted`, 404, 409, 410 | Yes |
| `create_public_output` | Private output (`public: false`) | No — always `available: false` in V1 |
| `retry_same_request` | `status=failed`, 422 `upload_failed` | Yes |
| `retry_after_wait` | 429 `rate_limited`, 503 `idempotency_in_flight`, 500 `server_error`, billing pending | Yes |
| `buy_credits` | 402 `quota_exhausted`, 402 `storage_limit_reached` | Varies |
| `check_capabilities` | 400 validation errors, billing confirmed | Varies |
| `register_key` | 401 `missing_api_key`, 401 `invalid_api_key` | Yes |
| `retry_checkout` | 404 `purchase_not_found`, billing failed | Yes |

### Notes on specific actions

**`create_public_output`**: Always appears with `available: false` in V1 responses for private outputs. The `required_body_changes` field will contain `{ "public": true }`. The action informs the agent that the output cannot be made public retroactively — a new output must be created with `public: true`.

**`retry_after_wait`**: Always carries a `retry_after_seconds` field. Agents must wait at least this many seconds before retrying.

**`retry_same_request`**: Agents should retry with the identical Idempotency-Key. For failed uploads, the idempotency slot is released, so the retry will receive a fresh upload attempt (not a cached failure).

---

## 19 Error Codes

These codes appear in the `error` field of error responses alongside `agent_contract`. They are part of the V1 stability guarantee.

| Code | HTTP Status | `retryable` | Recommended action |
|------|-------------|-------------|-------------------|
| `missing_idempotency_key` | 400 | No | `check_capabilities` |
| `invalid_mime_type` | 400 | No | `check_capabilities` |
| `payload_too_large` | 400 | No | `check_capabilities` |
| `invalid_metadata` | 400 | No | `check_capabilities` |
| `invalid_expiry` | 400 | No | `check_capabilities` |
| `invalid_request` | 400 | No | `check_capabilities` |
| `missing_api_key` | 401 | No | `register_key` |
| `invalid_api_key` | 401 | No | `register_key` |
| `quota_exhausted` | 402 | No | `buy_credits` |
| `storage_limit_reached` | 402 | No | `delete_output` |
| `output_not_found` | 404 | No | `create_new_output` |
| `purchase_not_found` | 404 | No | `retry_checkout` |
| `idempotency_conflict` | 409 | No | `create_new_output` |
| `output_expired` | 410 | No | `create_new_output` |
| `output_deleted` | 410 | No | `create_new_output` |
| `upload_failed` | 422 | Yes | `retry_same_request` |
| `rate_limited` | 429 | Yes | `retry_after_wait` |
| `server_error` | 500 | Yes | `retry_after_wait` |
| `idempotency_in_flight` | 503 | Yes | `retry_after_wait` |

### Error response envelope

All error responses share this shape:

```json
{
  "error": "invalid_mime_type",
  "message": "Human-readable description of the error.",
  "request_id": "req_01JXXXXX",
  "agent_contract": { ... }
}
```

Fields use snake_case per OutputLayer conventions. The `agent_contract` is always present on error responses.

---

## Contract Builders

Three builder functions construct contracts. Agents do not call these directly but understanding them helps predict contract shapes.

### `buildOutputContract(params)`

Used by: `GET /v1/outputs/:id`, `POST /v1/outputs` (201), `DELETE /v1/outputs/:id`

Behavior by status:
- `ready` + `publicUrl`: `content_accessible: true`, `safe_to_share: true`, recommended action = `share_public_url`
- `ready` + no `publicUrl`: `content_accessible: true`, `safe_to_share: false`, recommended action = `download_content`
- `failed`: `content_accessible: false`, `retryable: true`, recommended action = `retry_same_request`
- `expired` or `deleted`: `content_accessible: false`, `retryable: false`, recommended action = `create_new_output`

### `buildErrorContract(params)`

Used by all error responses. Maps error code to a specific next_actions array (see table above).

### `buildBillingVerifyContract(purchaseStatus)`

Used by: `GET /v1/credits/verify`

Behavior by purchase status:
- `confirmed`: recommended action = `check_capabilities`
- `pending`: `retryable: true`, recommended action = `retry_after_wait` (5s)
- `failed`: recommended action = `retry_checkout`

---

## V1 Stability Guarantee

The following constitute breaking changes (require `/v2/` route + 6-month deprecation):

- Removing or renaming any `AgentContract` field
- Removing or renaming any `Action` field
- Removing or renaming any of the 11 stable action codes
- Removing or renaming any of the 19 error codes
- Changing `retryable` semantics
- Changing `recommended` semantics

Additive changes (new optional fields, new action codes) are non-breaking and stay in `/v1/`.

Deprecated endpoints include `Deprecation` and `Sunset` HTTP headers and a `migration_note` field on `agent_contract`.
