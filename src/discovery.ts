/**
 * `GET /.well-known/openid-configuration`, fetched once and cached.
 *
 * The SDK never hardcodes `{issuer}/oauth/authorize`: the endpoints come from
 * the document, which is what makes the package work against an environment
 * that moves them. The fetch is also the sandbox guard's evidence — a
 * document whose `issuer` is not the configured one means the host answering
 * is not the environment the application thinks it is talking to (ruling 4).
 */

import { EnvironmentMismatch, KleoraError } from './errors.js'
import type { DiscoveryDocument } from './types.js'

const PATH = '/.well-known/openid-configuration'

const REQUIRED = [
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'userinfo_endpoint',
  'jwks_uri',
  'revocation_endpoint',
  'end_session_endpoint',
] as const

/**
 * Returns a function that resolves the document, fetching at most once.
 *
 * The promise itself is the cache, so concurrent first callers share one
 * request. A failed fetch is not cached: a transient network error must not
 * make the client permanently unusable.
 */
export function createDiscovery(
  issuer: URL,
  fetchImpl: () => typeof fetch,
): () => Promise<DiscoveryDocument> {
  let cached: Promise<DiscoveryDocument> | null = null

  return () => {
    cached ??= load(issuer, fetchImpl()).catch((error: unknown) => {
      // An `EnvironmentMismatch` is a permanent configuration fault, so it
      // stays cached; anything else gets another chance.
      if (!(error instanceof EnvironmentMismatch)) {
        cached = null
      }
      throw error
    })
    return cached
  }
}

async function load(issuer: URL, fetchImpl: typeof fetch): Promise<DiscoveryDocument> {
  const url = new URL(issuer.href.replace(/\/+$/, '') + PATH)
  let response: Response
  try {
    response = await fetchImpl(url.href, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    })
  } catch (cause) {
    throw new KleoraError(
      'discovery_unreachable',
      `could not reach the discovery document at ${url.href}: ${String(cause)}`,
    )
  }

  if (!response.ok) {
    throw new KleoraError(
      'discovery_unreachable',
      `the discovery document at ${url.href} answered ${String(response.status)}`,
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new KleoraError('discovery_malformed', `${url.href} did not answer with JSON`)
  }
  if (typeof body !== 'object' || body === null) {
    throw new KleoraError('discovery_malformed', `${url.href} did not answer with a JSON object`)
  }

  const document = body as Record<string, unknown>
  for (const field of REQUIRED) {
    if (typeof document[field] !== 'string') {
      throw new KleoraError(
        'discovery_malformed',
        `the discovery document at ${url.href} has no string '${field}'`,
      )
    }
  }

  const discovery = document as unknown as DiscoveryDocument
  if (discovery.issuer !== issuer.href.replace(/\/+$/, '')) {
    throw new EnvironmentMismatch(
      `the discovery document at ${url.href} names issuer '${discovery.issuer}', ` +
        `but this client is configured for '${issuer.href.replace(/\/+$/, '')}'`,
    )
  }

  // Every endpoint the client is now willing to call must live on the
  // issuer's own origin. The issuer serves each of them as
  // `{issuer}/…`, so anything else is either a different environment or a
  // document that is not this environment's — and this is a stricter test
  // than classifying the host, which cannot tell a production endpoint
  // announced by a sandbox document from a legitimate one.
  for (const field of REQUIRED) {
    if (field === 'issuer') continue
    const endpoint = new URL(discovery[field])
    if (endpoint.origin !== issuer.origin) {
      throw new EnvironmentMismatch(
        `the discovery document's ${field} is '${endpoint.href}', which is not on the ` +
          `issuer's origin '${issuer.origin}'`,
      )
    }
  }

  return discovery
}
