/**
 * The one request shape this package makes: a form POST to `/oauth/token`.
 *
 * `credentials: 'omit'` deliberately. The issuer gives the token
 * endpoint an `Access-Control-Allow-Origin` echo with no
 * `Access-Control-Allow-Credentials`, so a credentialled request would be
 * refused by the browser before it left; and the endpoint authenticates by
 * body or header, never by cookie, so there is nothing to send.
 */

import { ApiError, OAuthError, KleoraError } from './errors.js'
import type { TokenResponse } from './types.js'

const FORM = 'application/x-www-form-urlencoded'
const PROBLEM = 'application/problem+json'

/** Drop absent members so the body carries only what the endpoint reads. */
function encode(params: Record<string, string | undefined>): string {
  const body = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) body.append(name, value)
  }
  return body.toString()
}

export async function postToken(
  fetchImpl: typeof fetch,
  endpoint: string,
  params: Record<string, string | undefined>,
): Promise<TokenResponse> {
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': FORM, Accept: 'application/json' },
      body: encode(params),
      credentials: 'omit',
    })
  } catch (cause) {
    // A CORS refusal and a dead network are the same `TypeError` here; the
    // caller must not treat either as "the session is gone".
    throw new KleoraError(
      'network_error',
      `the request to ${endpoint} did not complete: ${String(cause)}`,
    )
  }

  const body = await parseBody(response)

  if (!response.ok) {
    throw toError(response, body)
  }

  if (typeof body !== 'object' || body === null) {
    throw new KleoraError('malformed_response', `${endpoint} did not answer with a JSON object`)
  }

  const token = body as Record<string, unknown>
  if (typeof token['access_token'] !== 'string' || typeof token['expires_in'] !== 'number') {
    throw new KleoraError(
      'malformed_response',
      `${endpoint} answered without an access_token and expires_in`,
    )
  }
  return token as unknown as TokenResponse
}

async function parseBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/**
 * RFC 6749 §5.2 for the OAuth endpoints, RFC 9457 for anything that answers
 * a problem document (a rate limit does).
 */
function toError(response: Response, body: unknown): KleoraError {
  const document = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}

  const contentType = response.headers.get('Content-Type') ?? ''
  if (contentType.includes(PROBLEM) || typeof document['type'] === 'string') {
    const errors = document['errors']
    return new ApiError(
      typeof document['type'] === 'string' ? document['type'] : 'about:blank',
      response.status,
      typeof document['detail'] === 'string' ? document['detail'] : undefined,
      Array.isArray(errors) ? errors : undefined,
    )
  }

  if (typeof document['error'] === 'string') {
    return new OAuthError(
      document['error'],
      typeof document['error_description'] === 'string' ? document['error_description'] : undefined,
      response.status,
    )
  }

  // A `5xx` with no parseable body — a gateway's HTML, or the issuer's own
  // generic `500`. Named rather than folded into `unexpected_response` below
  // because it is the one failure a developer is most likely to misdiagnose:
  // an older issuer's `500` from `/oauth/token` carried no
  // `Access-Control-Allow-Origin`, so this branch was unreachable from a
  // browser and the same fault arrived as the `network_error` above — "the
  // request did not complete", which is a sentence about the caller's network.
  // The two messages say which side the fault is on, and they are the only
  // evidence a developer has.
  if (response.status >= 500) {
    return new KleoraError(
      'server_error',
      `the issuer answered ${String(response.status)}: the request reached it and failed there`,
    )
  }

  return new KleoraError(
    'unexpected_response',
    `the token endpoint answered ${String(response.status)} with no recognisable error body`,
  )
}
