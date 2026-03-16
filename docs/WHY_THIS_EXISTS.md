# Why OutputLayer Exists

## The Problem

AI agents generate files. Reports, images, datasets, CSVs, PDFs, code bundles — artifacts that need to go somewhere after the agent produces them.

Today, most agent developers reach for one of three approaches:

**Base64 in tool responses.** The agent encodes the file and returns it inline. This works for small payloads, but a 5 MB PDF consumes context window budget, produces no shareable URL, and disappears when the conversation ends.

**Temporary files.** The agent writes to `/tmp` or a local directory. Convenient for single-machine workflows, but invisible to other agents, unreachable over the network, and lost on process restart.

**S3 directly.** The agent uploads to an S3-compatible bucket. Reliable, but requires an AWS account, IAM credentials, a bucket, a bucket policy, a presigned URL strategy, and an expiration lifecycle. Half a day of infrastructure work before a single artifact is stored.

None of these were designed for agents. They don't provide machine-readable retry guidance, don't enforce idempotency, don't expire automatically, and don't tell the agent what to do when something goes wrong.

## The Key Insight

Agents need a storage layer that speaks their language. Not a general-purpose object store, but a purpose-built artifact API that:

- Accepts an upload and returns a URL in one call
- Requires idempotency so retries are safe by default
- Expires artifacts automatically so nothing accumulates
- Returns structured guidance on every response so the agent knows its next action without parsing error strings
- Works without infrastructure setup — no buckets, no IAM, no lifecycle policies

## Design Principles

**Agent-first, not human-first.** Every API response includes `agent_contract` — a structured field that tells the calling agent what it can safely do next. Agents read `next_actions`, not error messages.

**Safe by default.** Idempotency is required, not optional. Artifacts expire automatically. Private by default, public only when explicitly requested.

**Zero infrastructure.** One POST to register. One POST to upload. No accounts, no dashboards, no bucket configuration. The developer writes agent code, not infrastructure code.

**Predictable failure.** When something goes wrong — quota exhausted, rate limited, upload too large — the response includes a machine-readable explanation and a recommended recovery action. The agent can self-correct without human intervention.

## What This Enables

An agent pipeline that stores artifacts becomes:

```
1. Agent generates file
2. POST /v1/outputs (with Idempotency-Key)
3. Read agent_contract.next_actions
4. Return contentUrl or publicUrl to the user
```

No credential management. No bucket setup. No expiration cron jobs. No retry logic beyond "send the same request again with the same idempotency key."

The artifact has a URL, a lifecycle, and a contract. The agent moves on.

## The Long-Term Vision

OutputLayer is a dedicated infrastructure layer for agent-generated artifacts. As agent systems become more autonomous, the artifacts they produce need reliable, programmable storage that agents can operate independently — not storage designed for humans clicking through dashboards.

The goal is to make artifact storage a solved problem for agent developers, the same way CDNs made content delivery a solved problem for web developers.
