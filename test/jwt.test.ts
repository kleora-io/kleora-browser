/** ID-token validation: `iss`, `aud`, `nonce`, `exp` (ruling 2). */

import { describe, expect, it } from 'vitest'

import { TokenError } from '../src/errors.js'
import { CLOCK_LEEWAY_SECONDS, decodeJwt, userFromClaims, validateIdToken } from '../src/jwt.js'
import { idToken, jwt } from './tokens.js'

const ISSUER = 'https://acme.kleora.eu'
const CLIENT_ID = 'kleora-console'

function checksFor(nonce?: string) {
  return nonce === undefined
    ? { issuer: ISSUER, clientId: CLIENT_ID }
    : { issuer: ISSUER, clientId: CLIENT_ID, nonce }
}

describe('decodeJwt', () => {
  it('reads the payload of a well-formed token', () => {
    expect(decodeJwt(jwt({ sub: 'x' }))['sub']).toBe('x')
  })

  it.each([
    ['not a jwt at all', 'nonsense'],
    ['two segments', 'aaa.bbb'],
    ['a payload that is not JSON', 'aaa.bm90LWpzb24.ccc'],
    ['a payload that is a JSON array', `aaa.${Buffer.from('[1]').toString('base64url')}.ccc`],
  ])('refuses %s', (_name, token) => {
    expect(() => decodeJwt(token)).toThrow(TokenError)
  })
})

describe('validateIdToken', () => {
  it('accepts a token minted for this issuer, client and nonce', () => {
    const claims = validateIdToken(
      idToken({ iss: ISSUER, aud: CLIENT_ID, nonce: 'n-1' }),
      checksFor('n-1'),
    )

    expect(claims['nonce']).toBe('n-1')
  })

  it('rejects an iss that differs only by a trailing slash', () => {
    // The comparison is exact.
    const token = idToken({ iss: `${ISSUER}/`, aud: CLIENT_ID })

    expect(() => validateIdToken(token, checksFor())).toThrow(
      expect.objectContaining({ code: 'issuer_mismatch' }),
    )
  })

  it('rejects a token minted for another client', () => {
    const token = idToken({ iss: ISSUER, aud: 'some-other-client' })

    expect(() => validateIdToken(token, checksFor())).toThrow(
      expect.objectContaining({ code: 'audience_mismatch' }),
    )
  })

  it('accepts an array aud that contains the client id', () => {
    const token = idToken({ iss: ISSUER, aud: ['someone-else', CLIENT_ID] as unknown as string })

    expect(validateIdToken(token, checksFor())['sub']).toBeTypeOf('string')
  })

  it('rejects a nonce that is not the one we sent', () => {
    const token = idToken({ iss: ISSUER, aud: CLIENT_ID, nonce: 'theirs' })

    expect(() => validateIdToken(token, checksFor('ours'))).toThrow(
      expect.objectContaining({ code: 'nonce_mismatch' }),
    )
  })

  it('rejects a missing nonce when one was requested', () => {
    const token = idToken({ iss: ISSUER, aud: CLIENT_ID })

    expect(() => validateIdToken(token, checksFor('ours'))).toThrow(
      expect.objectContaining({ code: 'nonce_mismatch' }),
    )
  })

  it('ignores the nonce when none was requested, as a rotated token carries none', () => {
    const token = idToken({ iss: ISSUER, aud: CLIENT_ID })

    expect(validateIdToken(token, checksFor())['nonce']).toBeUndefined()
  })

  it('tolerates an exp 30 s in the past and refuses one 90 s in the past', () => {
    // 30 s passes, 90 s fails, with
    // 60 s of leeway.
    const now = 1_800_000_000
    const stale = idToken({ iss: ISSUER, aud: CLIENT_ID, exp: now - 30 })
    const dead = idToken({ iss: ISSUER, aud: CLIENT_ID, exp: now - 90 })

    expect(validateIdToken(stale, { ...checksFor(), now })['exp']).toBe(now - 30)
    expect(() => validateIdToken(dead, { ...checksFor(), now })).toThrow(
      expect.objectContaining({ code: 'expired' }),
    )
    expect(CLOCK_LEEWAY_SECONDS).toBe(60)
  })

  it('refuses an iat more than the leeway into the future', () => {
    // An `iat` more than 60 s in the future fails.
    const now = 1_800_000_000
    const skewed = idToken({ iss: ISSUER, aud: CLIENT_ID, iat: now + 90, exp: now + 900 })
    const tolerable = idToken({ iss: ISSUER, aud: CLIENT_ID, iat: now + 30, exp: now + 900 })

    expect(() => validateIdToken(skewed, { ...checksFor(), now })).toThrow(
      expect.objectContaining({ code: 'expired' }),
    )
    expect(validateIdToken(tolerable, { ...checksFor(), now })['iat']).toBe(now + 30)
  })

  it('refuses a token with no numeric exp', () => {
    const token = jwt({ iss: ISSUER, aud: CLIENT_ID })

    expect(() => validateIdToken(token, checksFor())).toThrow(
      expect.objectContaining({ code: 'malformed' }),
    )
  })
})

describe('userFromClaims', () => {
  it('exposes exactly the documented claims', () => {
    const user = userFromClaims({
      sub: 'user-1',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada',
      picture: 'https://cdn.example/a.png',
      tenant: 'tenant-1',
      tenant_slug: 'acme',
      roles: ['owner'],
      permissions: ['users:read'],
    })

    expect(user).toEqual({
      sub: 'user-1',
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada',
      picture: 'https://cdn.example/a.png',
      tenant: 'tenant-1',
      tenant_slug: 'acme',
    })
  })

  it('omits absent claims rather than setting them to undefined', () => {
    expect(Object.keys(userFromClaims({ sub: 'user-1' }))).toEqual(['sub'])
  })
})
