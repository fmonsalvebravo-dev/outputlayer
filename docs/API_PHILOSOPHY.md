# OutputLayer — API Philosophy

## Overview

OutputLayer is designed as an agent-native API. Every decision — from required idempotency to structured error responses — reflects a single premise: the primary consumer of this API is an autonomous program, not a human clicking through a UI.

This document explains the reasoning behind the API's design choices.

## Machine-Readable Recovery

When an API call fails, the agent needs to know what to do next. Not what went wrong in human terms — what action to take programmatically.

Every OutputLayer response includes `agent_contract`, a structured field containing:

- Whether the request can be retried
- What actions are available
- Which action is recommended
- The HTTP method and endpoint for each action

```json
{
  "error": "quota_exhausted",
  "agent_contract": {
    "retryable": false,
    "next_actions": [
      { "action": "buy_credits", "method": "GET", "endpoint": "/v1/capabilities" }
    ]
  }
}
```

The agent reads `next_actions[0]` and acts. No error string parsing. No status code tables. No guesswork.

## Required Idempotency

`POST /v1/outputs` requires an `Idempotency-Key` header. This is not optional.

Agent pipelines frequently retry operations — network timeouts, process restarts, retry loops. Without idempotency, a retry creates a duplicate artifact. With it, a retry returns the original result.

| Without idempotency | With idempotency |
|---------------------|-----------------|
| Retry creates duplicate | Retry returns original |
| Agent must track what succeeded | Agent retries freely |
| Billing is unpredictable | Billing is deterministic |

The cost is one extra header. The benefit is that every upload is safe to retry by default.

## Deterministic Artifact Lifecycle

Artifacts follow a fixed state progression: `uploading → ready → expired` (or `deleted`). There are no ambiguous intermediate states, no manual transitions, and no configuration required.

- Upload succeeds → `ready`
- TTL elapses → `expired`
- Owner deletes → `deleted`
- Upload fails mid-stream → no record created

The agent can always determine the artifact's state from the response, and `agent_contract.content_accessible` tells it whether the content can be downloaded right now.

## Automatic Expiration

All artifacts expire. The default TTL is 7 days. A custom `expiresAt` can be set at upload time.

This is a deliberate choice: agent-generated artifacts are typically transient. A report generated today is rarely needed next month. Automatic expiration prevents unbounded storage growth without requiring cleanup logic in the agent.

After expiry, the artifact returns `410 output_expired` with `agent_contract.content_accessible: false`. The agent knows immediately that the content is gone and does not need to handle ambiguous "not found" states differently from "expired."

## Private by Default, Public by Choice

Artifacts are private by default. Only the API key owner can access the content, via the authenticated `/v1/outputs/:id/content` endpoint.

Setting `"public": true` at upload time generates a CDN URL. Public artifacts are served directly from Cloudflare CDN without authentication.

This separation exists because agents often generate artifacts containing user data or intermediate results that should not be publicly accessible. Making privacy the default prevents accidental exposure.

## Zero-Configuration Onboarding

Registration is a single unauthenticated POST. No email, no account creation form, no OAuth flow.

```bash
curl -X POST https://api.outputlayer.dev/v1/keys/register \
  -H "Content-Type: application/json" -d '{}'
```

The agent receives an API key and can immediately upload artifacts. The design assumes that the agent — not a human — is the one registering. Agents should not need to navigate account creation flows.

## Predictable Failure Behavior

Every failure mode has a defined response shape with `agent_contract` guidance:

| Failure | Status | agent_contract action |
|---------|--------|----------------------|
| Rate limited | 429 | `retry_after_wait` with seconds |
| Quota exhausted | 402 | `buy_credits` |
| File too large | 400 | `upgrade_plan` |
| Wrong method | 405 | `register_key` with correct method |
| Expired artifact | 410 | (no recovery action) |

The agent never encounters an unstructured error. Every failure tells the agent whether to retry, wait, upgrade, or stop.

## Stability Over Features

The V1 API contract is stable. New fields may be added to responses (non-breaking), but existing fields will not be removed or renamed. Breaking changes require a `/v2/` route with a minimum 6-month deprecation period.

This matters for agents because they are often deployed and left running for extended periods. An API that changes its response shape without warning breaks agent pipelines silently.
