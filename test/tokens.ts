/**
 * Unsigned JWTs for the unit suite.
 *
 * The signature is a constant, and that is deliberate rather than lazy: the
 * browser SDK never looks at one (see `src/jwt.ts`), so a test that produced
 * a real ES256 signature would be asserting something the code under test
 * does not do.
 */

const HEADER = { alg: 'ES256', typ: 'JWT', kid: 'test' }

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function jwt(claims: Record<string, unknown>): string {
  return `${segment(HEADER)}.${segment(claims)}.c2lnbmF0dXJl`
}

export interface IdTokenParts {
  iss: string
  aud: string
  sub?: string
  nonce?: string
  exp?: number
  [claim: string]: unknown
}

/** An ID token that is valid unless a test says otherwise. */
export function idToken(parts: IdTokenParts): string {
  return jwt({
    sub: 'ea0f3b1c-4b3f-4f7a-9b2e-2c9a1d8e5f01',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900,
    ...parts,
  })
}
