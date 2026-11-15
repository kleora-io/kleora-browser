/**
 * ID-token inspection.
 *
 * **The browser does not verify signatures.** It cannot do so usefully: the
 * token arrived over TLS from the token endpoint in direct response to a code
 * the SDK minted the verifier for, so an attacker able to substitute the body
 * has already broken the channel that a JWKS fetch would travel over too.
 * Signature verification belongs to the resource server
 * (`@kleora-io/node`, `kleora`), which receives tokens from
 * untrusted callers. What the SDK does check are the four things that pin
 * *this* token to *this* request: `iss`, `aud`, `nonce` and `exp`
 * (OpenID Connect Core §3.1.3.7).
 */

import { TokenError } from './errors.js'
import { base64UrlDecode } from './pkce.js'
import type { User } from './types.js'

/** The clock skew allowed when checking `exp` and `iat`. */
export const CLOCK_LEEWAY_SECONDS = 60

const JWT_SEGMENTS = 3

export type Claims = Record<string, unknown>

/** Read a JWT's payload without checking its signature. */
export function decodeJwt(token: string): Claims {
  const segments = token.split('.')
  if (segments.length !== JWT_SEGMENTS) {
    throw new TokenError('malformed', 'the token is not a three-segment JWT')
  }
  const payload = segments[1] ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)))
  } catch {
    throw new TokenError('malformed', "the token's payload is not base64url-encoded JSON")
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TokenError('malformed', "the token's payload is not a JSON object")
  }
  return parsed as Claims
}

export interface IdTokenChecks {
  /** Compared to `iss` byte for byte — a trailing slash is a mismatch. */
  issuer: string
  /** Must appear in `aud`, which the ID token carries as a string. */
  clientId: string
  /**
   * The `nonce` sent with the authorization request. Absent for a token
   * obtained by refreshing: the rotation grant has no authorization request
   * to copy one from and the backend issues the ID token without the claim.
   */
  nonce?: string | undefined
  /** Seconds since the epoch; defaults to the current clock. */
  now?: number
  leewaySeconds?: number
}

/**
 * Validate an ID token and return its claims.
 *
 * @throws {TokenError} on any of `issuer_mismatch`, `audience_mismatch`,
 * `nonce_mismatch`, `expired`, `malformed`.
 */
export function validateIdToken(token: string, checks: IdTokenChecks): Claims {
  const claims = decodeJwt(token)
  const leeway = checks.leewaySeconds ?? CLOCK_LEEWAY_SECONDS
  const now = checks.now ?? Math.floor(Date.now() / 1000)

  if (claims['iss'] !== checks.issuer) {
    throw new TokenError(
      'issuer_mismatch',
      `the id_token's iss is '${String(claims['iss'])}', expected '${checks.issuer}'`,
    )
  }

  const audience = claims['aud']
  const audiences = typeof audience === 'string' ? [audience] : audience
  if (!Array.isArray(audiences) || !audiences.includes(checks.clientId)) {
    throw new TokenError(
      'audience_mismatch',
      `the id_token's aud does not contain the client id '${checks.clientId}'`,
    )
  }

  if (checks.nonce !== undefined && claims['nonce'] !== checks.nonce) {
    throw new TokenError(
      'nonce_mismatch',
      "the id_token's nonce does not match the one sent with the authorization request",
    )
  }

  const exp = claims['exp']
  if (typeof exp !== 'number') {
    throw new TokenError('malformed', "the id_token has no numeric exp claim")
  }
  if (now > exp + leeway) {
    throw new TokenError('expired', `the id_token expired at ${exp} (${leeway}s of leeway allowed)`)
  }

  // An `iat` more than 60 s in the future fails. A token issued ahead of our clock by more than the skew we
  // allow is either a badly wrong clock somewhere or a token that was not
  // minted for this moment; either way `exp` cannot be trusted to mean what
  // it says. Checked only when the claim is a number — an ID token always
  // carries one, and refusing a token for the shape of a claim this package
  // otherwise ignores would be stricter than the spec asks.
  const iat = claims['iat']
  if (typeof iat === 'number' && iat > now + leeway) {
    throw new TokenError(
      'expired',
      `the id_token was issued at ${iat}, which is more than ${leeway}s in the future`,
    )
  }

  return claims
}

function optionalString(claims: Claims, name: string): string | undefined {
  const value = claims[name]
  return typeof value === 'string' ? value : undefined
}

/** The claims `getUser()` exposes, and nothing else. */
export function userFromClaims(claims: Claims): User {
  const emailVerified = claims['email_verified']
  const user: User = { sub: optionalString(claims, 'sub') ?? '' }
  const email = optionalString(claims, 'email')
  const name = optionalString(claims, 'name')
  const picture = optionalString(claims, 'picture')
  const tenant = optionalString(claims, 'tenant')
  const tenantSlug = optionalString(claims, 'tenant_slug')

  if (email !== undefined) user.email = email
  if (typeof emailVerified === 'boolean') user.email_verified = emailVerified
  if (name !== undefined) user.name = name
  if (picture !== undefined) user.picture = picture
  if (tenant !== undefined) user.tenant = tenant
  if (tenantSlug !== undefined) user.tenant_slug = tenantSlug

  return user
}
