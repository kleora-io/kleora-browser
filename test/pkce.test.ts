/** PKCE against RFC 7636's own vectors. */

import { describe, expect, it } from 'vitest'

import {
  base64UrlDecode,
  base64UrlEncode,
  codeChallengeS256,
  createCodeVerifier,
  randomValue,
} from '../src/pkce.js'

const UNRESERVED = /^[A-Za-z0-9._~-]+$/

describe('base64url', () => {
  it('encodes RFC 7636 appendix B’s octet sequence', () => {
    // The appendix spells the verifier out as bytes before it spells it out
    // as a string; encoding those bytes has to produce that string.
    const octets = Uint8Array.from([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
      105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ])

    expect(base64UrlEncode(octets)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
  })

  it('round-trips through the decoder', () => {
    const bytes = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255])

    expect([...base64UrlDecode(base64UrlEncode(bytes))]).toEqual([...bytes])
  })

  it('never emits padding or the two characters base64url replaces', () => {
    // One, two and three bytes cover every padding case.
    for (const length of [1, 2, 3]) {
      const encoded = base64UrlEncode(new Uint8Array(length).fill(255))

      expect(encoded).not.toContain('=')
      expect(encoded).not.toContain('+')
      expect(encoded).not.toContain('/')
    }
  })
})

describe('codeChallengeS256', () => {
  it('produces RFC 7636 appendix B’s challenge for its verifier', async () => {
    const challenge = await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')

    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('is stable for a given verifier and different for different ones', async () => {
    const first = await codeChallengeS256('a'.repeat(43))

    expect(await codeChallengeS256('a'.repeat(43))).toBe(first)
    expect(await codeChallengeS256('b'.repeat(43))).not.toBe(first)
  })
})

describe('createCodeVerifier', () => {
  it('is 43 characters of the unreserved set (RFC 7636 §4.1)', () => {
    const verifier = createCodeVerifier()

    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(UNRESERVED)
  })

  it('does not repeat', () => {
    const values = new Set(Array.from({ length: 200 }, () => createCodeVerifier()))

    expect(values.size).toBe(200)
  })
})

describe('randomValue', () => {
  it('carries 32 bytes of entropy by default and stays inside the 512-byte ceiling', () => {
    const value = randomValue()

    expect(base64UrlDecode(value)).toHaveLength(32)
    expect(value.length).toBeLessThanOrEqual(512)
    expect(value).toMatch(UNRESERVED)
  })
})
