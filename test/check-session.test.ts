/**
 * `checkSession()` — the ways a page load can recover a session, and the way
 * it gives up.
 *
 * It recovers from a still-fresh access token or from the stored refresh
 * token, and otherwise answers `null` **at once**. It used to fall back to a
 * `prompt=none` authorization in a hidden iframe with a 10 s budget, which
 * could never succeed — the issuer refuses to be framed, and a cross-site
 * frame does not get the `SameSite=Lax` session cookie anyway — and which
 * left a new console tab blank for those 10 s before the guard's redirect did
 * what the frame could not (gh-1073). So the document below records every
 * element anything asks it for, and the "no refresh token" cases run under
 * fake timers that are never advanced: a `null` that needed a timer to fire
 * would never arrive, and the test would time out instead of passing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKleora, DEFAULT_SCOPE } from '../src/client.js'
import * as browserSdk from '../src/index.js'
import type { KleoraOptions } from '../src/types.js'
import { installFakeBrowser, installFetch, json, type FakeBrowser } from './fake-browser.js'
import { idToken, jwt } from './tokens.js'

const ISSUER = 'https://acme.kleora.eu'
const CLIENT_ID = 'kleora-console'
const REDIRECT_URI = 'https://app.example.com/auth/callback'
const MARKER = `kleora:had-session:${CLIENT_ID}`
const REFRESH_TOKEN_KEY = `kleora:rt:${CLIENT_ID}`

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  userinfo_endpoint: `${ISSUER}/oauth/userinfo`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  end_session_endpoint: `${ISSUER}/oauth/logout`,
}

let browser: FakeBrowser
/** Every element the SDK asked the document for, by tag name. */
let created: string[]
let savedDocument: PropertyDescriptor | undefined

function scriptIssuer(response: () => Response): { calls: string[] } {
  const urls: string[] = []
  installFetch((url) => {
    urls.push(url)
    if (url.endsWith('/.well-known/openid-configuration')) return json(DISCOVERY)
    if (url === DISCOVERY.token_endpoint) return response()
    throw new Error(`unexpected request: ${url}`)
  })
  return { calls: urls }
}

/** An issuer that must not be asked anything at all. */
function silentIssuer(): { calls: string[] } {
  return scriptIssuer(() => {
    throw new Error('no token request may be made')
  })
}

function tokens(refreshToken = 'rt-2'): Response {
  return json({
    access_token: jwt({ iss: ISSUER, aud: [CLIENT_ID], env: 'production' }),
    token_type: 'Bearer',
    expires_in: 900,
    scope: DEFAULT_SCOPE,
    id_token: idToken({ iss: ISSUER, aud: CLIENT_ID, email: 'ada@example.com' }),
    refresh_token: refreshToken,
  })
}

function client(overrides: Partial<KleoraOptions> = {}) {
  return createKleora({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  })
}

beforeEach(() => {
  browser = installFakeBrowser('https://app.example.com/')
  created = []
  savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: {
      createElement: (tag: string) => {
        created.push(tag)
        throw new Error(`checkSession() must not create a <${tag}>`)
      },
      body: { appendChild: () => undefined },
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  if (savedDocument === undefined) Reflect.deleteProperty(globalThis, 'document')
  else Object.defineProperty(globalThis, 'document', savedDocument)
})

describe('checkSession', () => {
  it('uses the stored refresh token under session storage', async () => {
    // A previous page load in this tab left a refresh token behind.
    browser.session.setItem(REFRESH_TOKEN_KEY, 'rt-from-a-previous-load')
    const issuer = scriptIssuer(() => tokens('rt-2'))

    const state = await client({ storage: 'session' }).checkSession()

    expect(state).toEqual({ user: expect.objectContaining({ email: 'ada@example.com' }), isAuthenticated: true })
    expect(issuer.calls).toContain(DISCOVERY.token_endpoint)
    expect(browser.session.getItem(REFRESH_TOKEN_KEY)).toBe('rt-2')
    expect(created).toEqual([])
    expect(browser.location.navigations).toEqual([])
  })

  it('resolves null at once with a marker and no refresh token — no iframe, no timer, no request', async () => {
    // The new-tab case (gh-1073): the marker is origin-wide and survives, the
    // `session`-storage refresh token is tab-scoped and does not.
    vi.useFakeTimers()
    browser.local.setItem(MARKER, '1')
    const issuer = silentIssuer()
    const kleora = client({ storage: 'session' })

    // Never advanced: a `null` that waited on a timer would never arrive.
    await expect(kleora.checkSession()).resolves.toBeNull()

    expect(created).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(issuer.calls).toEqual([])
    expect(browser.location.navigations).toEqual([])
  })

  it('resolves null at once under memory storage too, where every reload has no refresh token', async () => {
    vi.useFakeTimers()
    browser.local.setItem(MARKER, '1')
    const issuer = silentIssuer()

    await expect(client().checkSession()).resolves.toBeNull()

    expect(created).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(issuer.calls).toEqual([])
  })

  it('resolves null when the stored refresh token is dead, without trying anything else', async () => {
    browser.session.setItem(REFRESH_TOKEN_KEY, 'spent')
    const issuer = scriptIssuer(() => json({ error: 'invalid_grant' }, 400))
    const kleora = client({ storage: 'session' })

    await expect(kleora.checkSession()).resolves.toBeNull()

    // One refresh attempt and nothing after it: no authorize URL, no frame.
    expect(issuer.calls.filter(url => url === DISCOVERY.token_endpoint)).toHaveLength(1)
    expect(issuer.calls.some(url => url.startsWith(DISCOVERY.authorization_endpoint))).toBe(false)
    expect(created).toEqual([])
    // The spent token is gone, so a later getAccessToken() does not retry it.
    expect(browser.session.getItem(REFRESH_TOKEN_KEY)).toBeNull()
  })

  it('resolves null on a transient refresh failure and keeps the refresh token for next time', async () => {
    browser.session.setItem(REFRESH_TOKEN_KEY, 'still-good')
    scriptIssuer(() => json({ error: 'temporarily_unavailable' }, 503))

    await expect(client({ storage: 'session' }).checkSession()).resolves.toBeNull()

    expect(browser.session.getItem(REFRESH_TOKEN_KEY)).toBe('still-good')
    expect(created).toEqual([])
  })

  it('keeps SILENT_TIMEOUT_MS exported, deprecated, so an import of it still compiles', () => {
    expect(browserSdk.SILENT_TIMEOUT_MS).toBe(10_000)
  })

  /**
   * The render marker: what a page reload actually decides between.
   * A successful refresh sets it; a refresh token the issuer refused — an
   * authoritative "you are not signed in" — clears it; a tab that simply
   * holds no refresh token, which proves nothing about the issuer's session,
   * leaves it alone.
   */
  describe('the session marker', () => {
    it('is set once the stored refresh token recovers a session', async () => {
      browser.session.setItem(REFRESH_TOKEN_KEY, 'rt-1')
      scriptIssuer(() => tokens())
      const kleora = client({ storage: 'session' })

      await kleora.checkSession()

      expect(kleora.hasLikelySession()).toBe(true)
    })

    it('is cleared when the issuer refuses the refresh token', async () => {
      browser.local.setItem(MARKER, '1')
      browser.session.setItem(REFRESH_TOKEN_KEY, 'spent')
      scriptIssuer(() => json({ error: 'invalid_grant' }, 400))
      const kleora = client({ storage: 'session' })

      await kleora.checkSession()

      expect(kleora.hasLikelySession()).toBe(false)
    })

    it('is left alone when there is no refresh token to try', async () => {
      browser.local.setItem(MARKER, '1')
      silentIssuer()
      const kleora = client({ storage: 'session' })

      await expect(kleora.checkSession()).resolves.toBeNull()

      expect(kleora.hasLikelySession()).toBe(true)
    })

    it('is left alone by a transient refresh failure', async () => {
      browser.local.setItem(MARKER, '1')
      browser.session.setItem(REFRESH_TOKEN_KEY, 'still-good')
      scriptIssuer(() => json({ error: 'temporarily_unavailable' }, 503))
      const kleora = client({ storage: 'session' })

      await kleora.checkSession()

      expect(kleora.hasLikelySession()).toBe(true)
    })
  })
})
