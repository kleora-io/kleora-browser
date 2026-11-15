/**
 * Every browser global the SDK touches, reached lazily and in one place.
 *
 * Two reasons it is not a scattering of bare `window.` references. A module
 * that read `sessionStorage` at import time would throw when the bundle is
 * evaluated during server rendering, and Nuxt does exactly that
 * (authentication is client-only). And a single accessor per
 * global is what lets the unit tests install a small fake instead of pulling
 * in a whole DOM implementation.
 */

import { KleoraError } from './errors.js'

const NO_BROWSER = 'this API needs a browser: no %s is available in this runtime'

function required<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new KleoraError('unsupported_environment', NO_BROWSER.replace('%s', name))
  }
  return value
}

/** `crypto.subtle`, which PKCE and the random `state`/`nonce` both need. */
export function webCrypto(): Crypto {
  const candidate = (globalThis as { crypto?: Crypto }).crypto
  const crypto = required(candidate, 'Web Crypto')
  // Browsers expose `crypto.subtle` only on a secure origin. Saying so beats
  // a `TypeError` on `undefined.digest` from inside the PKCE helper.
  required(crypto.subtle as SubtleCrypto | undefined, 'crypto.subtle (a secure context is required)')
  return crypto
}

/**
 * `sessionStorage`, or `null` when it is unavailable.
 *
 * Safari in private browsing and any embedding that blocks storage throw on
 * access rather than returning `undefined`, so the probe is a `try`.
 */
export function sessionStore(): Storage | null {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null
  } catch {
    return null
  }
}

/**
 * `localStorage`, or `null` when it is unavailable.
 *
 * The **only** thing this package ever keeps here is the non-sensitive
 * "had a session" render marker (`session-marker.ts`) — a boolean hint, never
 * a token. `storage.ts` explains why a refresh token is never offered
 * `localStorage` as a home; that reasoning is unchanged and does not apply to
 * a marker that grants nothing and proves nothing on its own.
 */
export function localStore(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null
  } catch {
    return null
  }
}

/** The current location. */
export function locationRef(): Location {
  return required((globalThis as { location?: Location }).location, 'location')
}

/** The history API, used to strip the code out of the callback URL. */
export function historyRef(): History | null {
  return (globalThis as { history?: History }).history ?? null
}

/**
 * `fetch`, bound so that calling it does not trip the illegal-invocation
 * check some engines apply to a detached `fetch`.
 */
export function fetchRef(): typeof fetch {
  const impl = required((globalThis as { fetch?: typeof fetch }).fetch, 'fetch')
  return impl.bind(globalThis)
}

/**
 * `window.open`, for `openAccountPortal()`: the account portal opens in a new
 * tab or this window, never inside the page.
 */
export function openRef(): (url: string, target: string, features: string) => unknown {
  const open = (globalThis as { open?: (url: string, target: string, features: string) => unknown })
    .open
  const impl = required(open, 'window.open')
  return impl.bind(globalThis)
}
