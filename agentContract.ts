// ─── Types ────────────────────────────────────────────────────────────────────

// ─── V1 contract stability guarantee ─────────────────────────────────────────
// The following fields are stable in V1. Any removal, rename, or type change
// constitutes a breaking change and requires a /v2/ route plus a minimum
// 6-month deprecation coexistence period:
//
//   AgentContract fields:
//     version, content_accessible, safe_to_share, retryable,
//     expires_in_seconds, next_actions
//
//   Action fields:
//     action, available, recommended
//
//   Action enum codes (stable set):
//     download_content, share_public_url, delete_output, create_new_output,
//     create_public_output, retry_same_request, retry_after_wait,
//     buy_credits, check_capabilities, register_key,
//     retry_checkout
//
// Error codes (stable set includes billing additions):
//     purchase_not_found
//
// Additive changes (new optional fields, new action codes) are non-breaking
// and remain in /v1/ without a version bump.
//
// migration_note is set ONLY by deprecated endpoint handlers — never by the
// contract builders below. Deprecated handlers spread the built contract and
// add migration_note manually:
//   res.json({ ...body, agent_contract: { ...contract, migration_note: '...' } })

export interface Action {
  action: string
  available: boolean
  recommended: boolean
  description?: string
  method?: string
  endpoint?: string
  reason?: string
  retry_after_seconds?: number
  required_body_changes?: Record<string, unknown>
}

export interface AgentContract {
  version: '1'
  content_accessible: boolean
  safe_to_share: boolean
  retryable: boolean
  expires_in_seconds: number | null
  next_actions: Action[]
  /** Present only on responses from deprecated endpoints. Never set by the builders. */
  migration_note?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function secondsUntil(date: Date): number | null {
  const diff = Math.floor((date.getTime() - Date.now()) / 1000)
  return diff > 0 ? diff : null
}

// ─── Output contracts (success + terminal states) ─────────────────────────────

/**
 * Builds the agent_contract for a single output object response.
 * Used by GET /v1/outputs/:id, POST /v1/outputs (201), and DELETE /v1/outputs/:id.
 */
export function buildOutputContract(params: {
  status: 'ready' | 'expired' | 'failed' | 'deleted'
  outputId: string
  publicUrl: string | null
  expiresAt: Date | null
}): AgentContract {
  const { status, outputId, publicUrl, expiresAt } = params

  if (status === 'ready' && publicUrl) {
    // public output — share is primary action
    return {
      version: '1',
      content_accessible: true,
      safe_to_share: true,
      retryable: false,
      expires_in_seconds: expiresAt ? secondsUntil(expiresAt) : null,
      next_actions: [
        {
          action: 'share_public_url',
          available: true,
          recommended: true,
          description: 'Share this URL directly with end users or embed it in any message.',
          method: 'GET',
          endpoint: publicUrl,
        },
        {
          action: 'download_content',
          available: true,
          recommended: false,
          description: 'Download the raw content via the authenticated API endpoint.',
          method: 'GET',
          endpoint: `/v1/outputs/${outputId}/content`,
        },
        {
          action: 'delete_output',
          available: true,
          recommended: false,
          description: 'Delete this output when it is no longer needed.',
          method: 'DELETE',
          endpoint: `/v1/outputs/${outputId}`,
        },
      ],
    }
  }

  if (status === 'ready' && !publicUrl) {
    // private output — download is primary action
    return {
      version: '1',
      content_accessible: true,
      safe_to_share: false,
      retryable: false,
      expires_in_seconds: expiresAt ? secondsUntil(expiresAt) : null,
      next_actions: [
        {
          action: 'download_content',
          available: true,
          recommended: true,
          description: 'Download the raw content via the authenticated content endpoint.',
          method: 'GET',
          endpoint: `/v1/outputs/${outputId}/content`,
        },
        {
          action: 'create_public_output',
          available: false,
          recommended: false,
          reason: 'This output was created without public:true.',
          required_body_changes: { public: true },
        },
        {
          action: 'delete_output',
          available: true,
          recommended: false,
          description: 'Delete this output when it is no longer needed.',
          method: 'DELETE',
          endpoint: `/v1/outputs/${outputId}`,
        },
      ],
    }
  }

  if (status === 'failed') {
    // upload failed — retry is primary action
    return {
      version: '1',
      content_accessible: false,
      safe_to_share: false,
      retryable: true,
      expires_in_seconds: expiresAt ? secondsUntil(expiresAt) : null,
      next_actions: [
        {
          action: 'retry_same_request',
          available: true,
          recommended: true,
          description: 'Retry the identical request with the same Idempotency-Key.',
          method: 'POST',
          endpoint: '/v1/outputs',
        },
      ],
    }
  }

  // expired or deleted — create new is primary action
  return {
    version: '1',
    content_accessible: false,
    safe_to_share: false,
    retryable: false,
    expires_in_seconds: null,
    next_actions: [
      {
        action: 'create_new_output',
        available: true,
        recommended: true,
        description:
          status === 'expired'
            ? 'The content for this output has expired. Upload again to create a new output.'
            : 'If you need to store a new artifact, create a new output.',
        method: 'POST',
        endpoint: '/v1/outputs',
      },
    ],
  }
}

// ─── Error contracts ──────────────────────────────────────────────────────────

/**
 * Builds the agent_contract for an error response.
 * errorCode must be one of the 17 defined error codes from the spec.
 * retryAfterSeconds is only used for rate_limited and server_error.
 */
export function buildErrorContract(params: {
  errorCode: string
  retryAfterSeconds?: number
}): AgentContract {
  const { errorCode, retryAfterSeconds } = params

  const base: Omit<AgentContract, 'next_actions'> = {
    version: '1',
    content_accessible: false,
    safe_to_share: false,
    retryable: false,
    expires_in_seconds: null,
  }

  switch (errorCode) {
    // 405 wrong method — tell the agent the correct method
    case 'wrong_method':
      return {
        ...base,
        retryable: true,
        next_actions: [
          {
            action: 'register_key',
            available: true,
            recommended: true,
            description: 'Register a new API key via POST /v1/keys/register.',
            method: 'POST',
            endpoint: '/v1/keys/register',
          },
        ],
      }

    // 400 validation errors — check capabilities
    case 'missing_idempotency_key':
    case 'invalid_mime_type':
    case 'payload_too_large':
    case 'invalid_metadata':
    case 'invalid_expiry':
    case 'invalid_request':
      return {
        ...base,
        next_actions: [
          {
            action: 'check_capabilities',
            available: true,
            recommended: true,
            description: 'Review API limits and requirements before retrying.',
            method: 'GET',
            endpoint: '/v1/capabilities',
          },
        ],
      }

    // 401 auth errors — register key
    case 'missing_api_key':
    case 'invalid_api_key':
      return {
        ...base,
        next_actions: [
          {
            action: 'register_key',
            available: true,
            recommended: true,
            description: 'Register a new API key via POST /v1/keys/register.',
            method: 'POST',
            endpoint: '/v1/keys/register',
          },
        ],
      }

    // 402 quota_exhausted — buy credits
    case 'quota_exhausted':
      return {
        ...base,
        next_actions: [
          {
            action: 'buy_credits',
            available: true,
            recommended: true,
            description:
              'Purchase a credit pack. After payment is confirmed, retry with the same Idempotency-Key.',
            method: 'POST',
            endpoint: '/v1/credits/checkout',
          },
          {
            action: 'check_capabilities',
            available: true,
            recommended: false,
            description: 'Review available credit packs and pricing information.',
            method: 'GET',
            endpoint: '/v1/capabilities',
          },
        ],
      }

    // 402 storage_limit_reached — delete to free space
    case 'storage_limit_reached':
      return {
        ...base,
        next_actions: [
          {
            action: 'delete_output',
            available: true,
            recommended: true,
            description:
              'Delete one or more existing outputs to free storage, then retry with the same Idempotency-Key.',
            method: 'DELETE',
            endpoint: '/v1/outputs/{outputId}',
          },
          {
            action: 'buy_credits',
            available: true,
            recommended: false,
            description: 'Upgrade to a higher-tier plan to increase your storage limit.',
            method: 'POST',
            endpoint: '/v1/credits/checkout',
          },
          {
            action: 'check_capabilities',
            available: true,
            recommended: false,
            description: 'Review storage limits and available upgrade options.',
            method: 'GET',
            endpoint: '/v1/capabilities',
          },
        ],
      }

    // 404 output not found
    case 'output_not_found':
      return {
        ...base,
        next_actions: [
          {
            action: 'create_new_output',
            available: true,
            recommended: true,
            description: 'This output does not exist. Upload a new artifact via POST /v1/outputs.',
            method: 'POST',
            endpoint: '/v1/outputs',
          },
        ],
      }

    // 409 idempotency conflict — generate new key
    case 'idempotency_conflict':
      return {
        ...base,
        next_actions: [
          {
            action: 'create_new_output',
            available: true,
            recommended: true,
            description:
              'The Idempotency-Key was reused with a different payload. Generate a new key and retry.',
            method: 'POST',
            endpoint: '/v1/outputs',
          },
        ],
      }

    // 404 purchase not found — start a new checkout
    case 'purchase_not_found':
      return {
        ...base,
        next_actions: [
          {
            action: 'retry_checkout',
            available: true,
            recommended: true,
            description:
              'This purchase record was not found. Start a new checkout session via POST /v1/credits/checkout.',
            method: 'POST',
            endpoint: '/v1/credits/checkout',
          },
        ],
      }

    // 410 expired or deleted — create new
    case 'output_expired':
    case 'output_deleted':
      return {
        ...base,
        next_actions: [
          {
            action: 'create_new_output',
            available: true,
            recommended: true,
            description:
              errorCode === 'output_expired'
                ? 'The content for this output has expired. Upload again to create a new output.'
                : 'This output has been deleted. Upload again to create a new output.',
            method: 'POST',
            endpoint: '/v1/outputs',
          },
        ],
      }

    // 422 upload failed — retry same request
    case 'upload_failed':
      return {
        ...base,
        retryable: true,
        next_actions: [
          {
            action: 'retry_same_request',
            available: true,
            recommended: true,
            description: 'Retry the identical request with the same Idempotency-Key.',
            method: 'POST',
            endpoint: '/v1/outputs',
          },
        ],
      }

    // 429 rate limited — wait and retry
    case 'rate_limited':
      return {
        ...base,
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            description:
              'Wait the specified number of seconds, then retry with the same Idempotency-Key.',
            method: 'POST',
            endpoint: '/v1/outputs',
            retry_after_seconds: retryAfterSeconds ?? 60,
          },
        ],
      }

    // 503 idempotency_in_flight — same key already being processed, retry after short wait
    case 'idempotency_in_flight':
      return {
        ...base,
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            description:
              'A request with this Idempotency-Key is already being processed. Wait and retry with the same key and payload.',
            method: 'POST',
            endpoint: '/v1/outputs',
            retry_after_seconds: retryAfterSeconds ?? 5,
          },
        ],
      }

    // 500 server error — wait and retry
    case 'server_error':
    default:
      return {
        ...base,
        retryable: true,
        next_actions: [
          {
            action: 'retry_after_wait',
            available: true,
            recommended: true,
            description:
              'An unexpected error occurred. Wait the specified number of seconds and retry.',
            method: 'POST',
            endpoint: '/v1/outputs',
            retry_after_seconds: retryAfterSeconds ?? 30,
          },
        ],
      }
  }
}

// ─── Billing contracts ────────────────────────────────────────────────────────

/**
 * Builds the agent_contract for GET /v1/credits/verify responses.
 * The contract varies by purchase status to guide the agent to the right next step.
 */
export function buildBillingVerifyContract(
  purchaseStatus: 'pending' | 'confirmed' | 'failed'
): AgentContract {
  const base: Omit<AgentContract, 'next_actions'> = {
    version: '1',
    content_accessible: false,
    safe_to_share: false,
    retryable: false,
    expires_in_seconds: null,
  }

  if (purchaseStatus === 'confirmed') {
    return {
      ...base,
      next_actions: [
        {
          action: 'check_capabilities',
          available: true,
          recommended: true,
          description: 'Credits have been added to your account. You may now create outputs.',
          method: 'GET',
          endpoint: '/v1/capabilities',
        },
      ],
    }
  }

  if (purchaseStatus === 'pending') {
    return {
      ...base,
      retryable: true,
      next_actions: [
        {
          action: 'retry_after_wait',
          available: true,
          recommended: true,
          description:
            'Payment is still processing. Wait a few seconds and retry GET /v1/credits/verify with the same purchaseId.',
          method: 'GET',
          endpoint: '/v1/credits/verify',
          retry_after_seconds: 5,
        },
      ],
    }
  }

  // failed
  return {
    ...base,
    next_actions: [
      {
        action: 'retry_checkout',
        available: true,
        recommended: true,
        description:
          'The payment did not complete. Start a new checkout session via POST /v1/credits/checkout.',
        method: 'POST',
        endpoint: '/v1/credits/checkout',
      },
    ],
  }
}
