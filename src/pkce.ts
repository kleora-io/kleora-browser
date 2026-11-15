/**
 * PKCE (RFC 7636) and the random values that pin one authorization request
 * to one browser tab.
 *
 * `S256` only: the issuer's discovery document advertises exactly that method and
 * the authorization endpoint refuses `plain`, so there is no code path here
 * that could downgrade.
 */

import { webCrypto } from './browser.js'

const BASE64URL_PAD = /=+$/
const BASE64_PLUS = /\+/g
const BASE64_SLASH = /\//g

/** RFC 4648 §5 without padding — the alphabet every PKCE value uses. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  // A loop rather than `String.fromCharCode(...bytes)`: the spread form
  // blows the argument limit on inputs this function has no reason to
  // refuse, and the values here (32 bytes, a 32-byte digest) are small
  // enough that the difference costs nothing.
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(BASE64_PLUS, '-').replace(BASE64_SLASH, '_').replace(BASE64URL_PAD, '')
}

/** The inverse, for reading a JWT segment. */
export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * `length` cryptographically random bytes, base64url-encoded.
 *
 * 32 bytes is the default everywhere it is used: it is 256 bits of entropy in
 * a 43-character string, which is both the minimum length RFC 7636 §4.1
 * allows a verifier and comfortably inside the 512-byte ceiling
 * the issuer puts on `state` and `nonce`.
 */
export function randomValue(length = 32): string {
  const bytes = new Uint8Array(length)
  webCrypto().getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** A `code_verifier`: 43 characters of the unreserved set (RFC 7636 §4.1). */
export function createCodeVerifier(): string {
  return randomValue(32)
}

/** `BASE64URL(SHA256(verifier))` — RFC 7636 §4.2. */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await webCrypto().subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64UrlEncode(new Uint8Array(digest))
}
