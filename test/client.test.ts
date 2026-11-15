/**
 * `createKleora` end to end against a scripted issuer.
 *
 * The issuer here is a `fetch` handler, not a mock of the SDK's own
 * collaborators: every test drives the public API and asserts on what went
 * out on the wire and what came back through `getUser()`, `getAccessToken()`
 * and `onAuthChange`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createKleora, DEFAULT_SCOPE, REFRESH_THRESHOLD_MS } from '../src/client.js'
import {
  ApiError,
  EnvironmentMismatch,
  LoginRequired,
  OAuthError,
  KleoraError,
} from '../src/errors.js'
import type { AuthState, KleoraOptions } from '../src/types.js'
import { formOf, installFakeBrowser, installFetch, json, type FakeBrowser } from './fake-browser.js'
import { idToken, jwt } from './tokens.js'

const ISSUER = 'https://acme.kleora.eu'
const CLIENT_ID = 'kleora-console'
const REDIRECT_URI = 'https://app.example.com/auth/callback'
const APP_ORIGIN = 'https://app.example.com'

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

beforeEach(() => {
  browser = installFakeBrowser(`${APP_ORIGIN}/`)
})

function client(overrides: Partial<KleoraOptions> = {}) {
  return createKleora({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  })
}

interface Issuer {
  /** Bodies `POST /oauth/token` will answer, in order. */
  tokenResponses: (() => Response)[]
  calls: { url: string; init: RequestInit | undefined }[]
  discoveryCount: () => number
}

function scriptIssuer(discovery: unknown = DISCOVERY): Issuer {
  const tokenResponses: (() => Response)[] = []
  let discoveryCount = 0

  const { calls } = installFetch((url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      discoveryCount += 1
      return json(discovery)
    }
    if (url === DISCOVERY.token_endpoint) {
      const next = tokenResponses.shift()
      if (next === undefined) throw new Error(`unexpected token request: ${url}`)
      return next()
    }
    throw new Error(`unexpected request: ${url}`)
  })

  return { tokenResponses, calls, discoveryCount: () => discoveryCount }
}

/**
 * The error a call rejected with, typed for assertion.
 *
 * `rejects.toThrow` asserts a shape; this is for the tests that need to read
 * two errors and compare them, where the comparison *is* the assertion.
 */
async function rejection<T extends KleoraError = KleoraError>(
  call: Promise<unknown>,
): Promise<T> {
  try {
    await call
  } catch (error) {
    return error as T
  }
  throw new Error('the call resolved, and this test needs it to reject')
}

/** The nonce the SDK actually sent on its most recent authorization. */
function lastNonce(): string {
  const authorize = browser.location.navigations.filter((href) =>
    href.startsWith(DISCOVERY.authorization_endpoint),
  )
  return new URL(authorize.at(-1) ?? '').searchParams.get('nonce') ?? ''
}

/**
 * A token response. `nonce` defaults to the one the SDK just sent (which is
 * what the issuer does with a code grant); pass `null` for a refresh, whose
 * ID token carries none, or a string to forge one.
 */
function tokens(overrides: Record<string, unknown> = {}, nonce?: string | null): Response {
  const echoed = nonce === undefined ? lastNonce() : nonce
  return json({
    access_token: jwt({ iss: ISSUER, aud: [CLIENT_ID], env: 'production', exp: 1 }),
    token_type: 'Bearer',
    expires_in: 900,
    scope: DEFAULT_SCOPE,
    id_token: idToken({
      iss: ISSUER,
      aud: CLIENT_ID,
      email: 'ada@example.com',
      tenant_slug: 'acme',
      ...(echoed === null ? {} : { nonce: echoed }),
    }),
    refresh_token: 'rt-1',
    ...overrides,
  })
}

/** Run `loginWithRedirect`, then land the browser on the callback URL. */
async function landOnCallback(
  kleora: ReturnType<typeof client>,
  options: Parameters<typeof kleora.loginWithRedirect>[0] = {},
  mutate: (params: URLSearchParams) => void = () => undefined,
): Promise<{ authorize: URL; callback: URL }> {
  await kleora.loginWithRedirect(options)
  const authorize = new URL(browser.location.navigations.at(-1) ?? '')

  const callback = new URL(REDIRECT_URI)
  callback.searchParams.set('code', 'the-code')
  callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
  callback.searchParams.set('iss', ISSUER)
  mutate(callback.searchParams)
  browser.location.href = callback.href

  return { authorize, callback }
}

describe('createKleora', () => {
  it('refuses a malformed issuer or redirect URI before any network call', () => {
    installFetch(() => {
      throw new Error('no request may be made')
    })

    expect(() => client({ issuer: 'not-a-url' })).toThrow(KleoraError)
    expect(() => client({ redirectUri: '/relative' })).toThrow(KleoraError)
    expect(() => client({ clientId: '' })).toThrow(KleoraError)
  })

  it('refuses a sandbox redirect URI on a production issuer', () => {
    installFetch(() => {
      throw new Error('no request may be made')
    })

    expect(() => client({ redirectUri: 'https://x-sandbox.kleora.eu/cb' })).toThrow(
      EnvironmentMismatch,
    )
  })

  it('accepts an issuer written with a trailing slash', async () => {
    const issuer = scriptIssuer()
    const kleora = client({ issuer: `${ISSUER}/` })
    issuer.tokenResponses.push(() => tokens())

    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    expect(kleora.getUser()?.email).toBe('ada@example.com')
  })
})

describe('loginWithRedirect', () => {
  it('navigates with every parameter the authorization request needs', async () => {
    scriptIssuer()
    const kleora = client()

    await kleora.loginWithRedirect()
    const url = new URL(browser.location.navigations[0] ?? '')

    expect(url.origin + url.pathname).toBe(DISCOVERY.authorization_endpoint)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('scope')).toBe(DEFAULT_SCOPE)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toHaveLength(43)
    expect(url.searchParams.get('state')).toHaveLength(43)
    expect(url.searchParams.get('nonce')).toHaveLength(43)
  })

  it('never puts the verifier in the URL', async () => {
    scriptIssuer()
    const kleora = client()

    await kleora.loginWithRedirect()
    const stored = Object.values(browser.session.snapshot()).map(
      (value) => JSON.parse(value) as { codeVerifier: string },
    )

    expect(stored).toHaveLength(1)
    expect(browser.location.navigations[0]).not.toContain(stored[0]?.codeVerifier ?? 'x')
  })

  it('mints a fresh state and nonce for every call', async () => {
    scriptIssuer()
    const kleora = client()

    await kleora.loginWithRedirect()
    await kleora.loginWithRedirect()
    const states = browser.location.navigations.map((href) =>
      new URL(href).searchParams.get('state'),
    )

    expect(states[0]).not.toBe(states[1])
    expect(Object.keys(browser.session.snapshot())).toHaveLength(2)
  })

  it('passes prompt, tenant and login_hint through', async () => {
    scriptIssuer()
    const kleora = client({ tenant: 'default' })

    await kleora.loginWithRedirect({
      prompt: 'login',
      tenant: 'acme',
      loginHint: 'ada@example.com',
    })
    const url = new URL(browser.location.navigations[0] ?? '')

    expect(url.searchParams.get('prompt')).toBe('login')
    expect(url.searchParams.get('tenant')).toBe('acme')
    expect(url.searchParams.get('login_hint')).toBe('ada@example.com')
  })

  it('falls back to the client-wide tenant and omits absent parameters', async () => {
    scriptIssuer()
    const kleora = client({ tenant: 'default' })

    await kleora.loginWithRedirect()
    const url = new URL(browser.location.navigations[0] ?? '')

    expect(url.searchParams.get('tenant')).toBe('default')
    expect(url.searchParams.has('prompt')).toBe(false)
    expect(url.searchParams.has('login_hint')).toBe(false)
  })

  it('fetches discovery once however many logins are started', async () => {
    const issuer = scriptIssuer()
    const kleora = client()

    await kleora.loginWithRedirect()
    await kleora.loginWithRedirect()

    expect(issuer.discoveryCount()).toBe(1)
  })

  it('reports an EnvironmentMismatch when discovery names another issuer', async () => {
    scriptIssuer({ ...DISCOVERY, issuer: 'https://acme-sandbox.kleora.eu' })
    const kleora = client()

    await expect(kleora.loginWithRedirect()).rejects.toThrow(EnvironmentMismatch)
  })

  it('reports an EnvironmentMismatch when an endpoint is off the issuer’s origin', async () => {
    scriptIssuer({ ...DISCOVERY, token_endpoint: 'https://evil.example/oauth/token' })
    const kleora = client()

    await expect(kleora.loginWithRedirect()).rejects.toThrow(EnvironmentMismatch)
  })
})

describe('handleRedirectCallback', () => {
  it('redeems the code with the stored verifier and returns the appState', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())

    const { authorize } = await landOnCallback(kleora, {
      returnTo: '/dashboard',
      appState: { from: 'test' },
    })
    const result = await kleora.handleRedirectCallback()

    const body = formOf(issuer.calls.at(-1)?.init)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('code_verifier')).toHaveLength(43)
    expect(body.has('client_secret')).toBe(false)
    expect(result.appState).toEqual({ returnTo: '/dashboard', from: 'test' })
    expect(authorize.searchParams.get('state')).toBeTruthy()
  })

  it('strips the credentials out of the address bar', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())

    await landOnCallback(kleora, {}, (params) => {
      params.set('keep', 'me')
    })
    await kleora.handleRedirectCallback()

    expect(browser.replaced).toEqual(['/auth/callback?keep=me'])
    expect(browser.location.href).toBe(`${APP_ORIGIN}/auth/callback?keep=me`)
  })

  it('cleans the URL even when the redemption fails', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => json({ error: 'invalid_grant' }, 400))

    await landOnCallback(kleora)
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(OAuthError)

    expect(browser.location.href).toBe(`${APP_ORIGIN}/auth/callback`)
  })

  it('rejects a state it never issued', async () => {
    const issuer = scriptIssuer()
    const kleora = client()

    await landOnCallback(kleora, {}, (params) => {
      params.set('state', 'forged')
    })
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_state' }),
    )
    expect(issuer.calls.filter((call) => call.url === DISCOVERY.token_endpoint)).toHaveLength(0)
  })

  it('spends a state once, so a replayed callback URL is rejected', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())

    const { callback } = await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    browser.location.href = callback.href
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ code: 'invalid_state' }),
    )
  })

  it('rejects a response whose iss is not the configured issuer (RFC 9207)', async () => {
    const issuer = scriptIssuer()
    const kleora = client()

    await landOnCallback(kleora, {}, (params) => {
      params.set('iss', 'https://evil.example')
    })
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ code: 'issuer_mismatch' }),
    )
    expect(issuer.calls.filter((call) => call.url === DISCOVERY.token_endpoint)).toHaveLength(0)
  })

  it('rejects a response with no iss at all', async () => {
    scriptIssuer()
    const kleora = client()

    await landOnCallback(kleora, {}, (params) => {
      params.delete('iss')
    })
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ code: 'issuer_mismatch' }),
    )
  })

  it('surfaces an authorization error as an OAuthError and drops the transaction', async () => {
    scriptIssuer()
    const kleora = client()

    await landOnCallback(kleora, {}, (params) => {
      params.delete('code')
      params.set('error', 'access_denied')
      params.set('error_description', 'not a member of the requested tenant')
    })
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ error: 'access_denied' }),
    )
    expect(browser.session.snapshot()).toEqual({})
  })

  it('rejects an id_token whose nonce is not the one it sent', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens({}, 'someone-elses-nonce'))

    await landOnCallback(kleora)
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ code: 'nonce_mismatch' }),
    )
  })

  it('accepts the nonce it actually sent', async () => {
    const issuer = scriptIssuer()
    const kleora = client()

    await kleora.loginWithRedirect()
    const authorize = new URL(browser.location.navigations[0] ?? '')
    issuer.tokenResponses.push(() => tokens())

    const callback = new URL(REDIRECT_URI)
    callback.searchParams.set('code', 'the-code')
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
    callback.searchParams.set('iss', ISSUER)
    browser.location.href = callback.href

    await kleora.handleRedirectCallback()

    expect(kleora.getUser()?.tenant_slug).toBe('acme')
  })

  it('refuses a token minted in the other environment', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() =>
      tokens({ access_token: jwt({ iss: ISSUER, aud: [CLIENT_ID], env: 'sandbox' }) }),
    )

    await landOnCallback(kleora)
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(EnvironmentMismatch)
  })

  it('refuses an access token that does not carry the configured audience', async () => {
    const issuer = scriptIssuer()
    const kleora = client({ audience: 'https://api.acme.example' })
    issuer.tokenResponses.push(() =>
      tokens({ access_token: jwt({ iss: ISSUER, aud: [CLIENT_ID], env: 'production' }) }),
    )

    await landOnCallback(kleora)
    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ code: 'audience_mismatch' }),
    )
  })

  it('emits the authenticated state to every subscriber', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    const seen: AuthState[] = []
    kleora.onAuthChange((state) => seen.push(state))

    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.isAuthenticated).toBe(true)
    expect(seen[0]?.user?.email).toBe('ada@example.com')
  })
})

describe('getAccessToken', () => {
  async function signedIn(overrides: Partial<KleoraOptions> = {}) {
    const issuer = scriptIssuer()
    const kleora = client(overrides)
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()
    return { issuer, kleora }
  }

  it('returns the cached token while it is more than 30 s from expiry', async () => {
    const { issuer, kleora } = await signedIn()
    const before = issuer.calls.length

    expect(await kleora.getAccessToken()).toBe(await kleora.getAccessToken())
    expect(issuer.calls).toHaveLength(before)
    expect(REFRESH_THRESHOLD_MS).toBe(30_000)
  })

  it('refreshes once the token is inside the threshold, and rotates the refresh token', async () => {
    const { issuer, kleora } = await signedIn()
    issuer.tokenResponses.push(() =>
      tokens(
        {
          access_token: jwt({ iss: ISSUER, aud: [CLIENT_ID], env: 'production', jti: 'second' }),
          refresh_token: 'rt-2',
        },
        null,
      ),
    )

    vi.setSystemTime(Date.now() + 900_000 - 20_000)
    const refreshed = await kleora.getAccessToken()

    const body = formOf(issuer.calls.at(-1)?.init)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt-1')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(refreshed).not.toBe('')

    // The rotated token replaces the spent one on the next refresh.
    issuer.tokenResponses.push(() => tokens({ refresh_token: 'rt-3' }, null))
    vi.setSystemTime(Date.now() + 900_000)
    await kleora.getAccessToken()
    expect(formOf(issuer.calls.at(-1)?.init).get('refresh_token')).toBe('rt-2')

    vi.useRealTimers()
  })

  it('shares one in-flight refresh between concurrent callers', async () => {
    const { issuer, kleora } = await signedIn()
    // Exactly one refresh is scripted: a second would throw "unexpected
    // token request", which is the assertion. With rotation, a second
    // request would also be reuse and would revoke the family.
    issuer.tokenResponses.push(() => tokens({ refresh_token: 'rt-2' }, null))

    vi.setSystemTime(Date.now() + 900_000)
    const results = await Promise.all([
      kleora.getAccessToken(),
      kleora.getAccessToken(),
      kleora.getAccessToken(),
    ])

    expect(new Set(results).size).toBe(1)
    expect(issuer.calls.filter((call) => call.url === DISCOVERY.token_endpoint)).toHaveLength(2)

    vi.useRealTimers()
  })

  it('refreshes a token that is nowhere near expiry under `force`', async () => {
    const { issuer, kleora } = await signedIn()
    const cached = await kleora.getAccessToken()
    const before = issuer.calls.length

    issuer.tokenResponses.push(() =>
      tokens(
        {
          access_token: jwt({ iss: ISSUER, aud: [CLIENT_ID], env: 'production', jti: 'forced' }),
          refresh_token: 'rt-2',
        },
        null,
      ),
    )

    const forced = await kleora.getAccessToken({ force: true })

    expect(forced).not.toBe(cached)
    expect(issuer.calls.length).toBeGreaterThan(before)
    expect(formOf(issuer.calls.at(-1)?.init).get('grant_type')).toBe('refresh_token')
    expect(formOf(issuer.calls.at(-1)?.init).get('refresh_token')).toBe('rt-1')
    // And the fresh one is what an ordinary caller gets afterwards.
    expect(await kleora.getAccessToken()).toBe(forced)
  })

  it('shares one in-flight refresh between a forced caller and an ordinary one', async () => {
    const { issuer, kleora } = await signedIn()
    // One scripted response: a second request would be refresh-token reuse
    // and would revoke the whole family.
    issuer.tokenResponses.push(() => tokens({ refresh_token: 'rt-2' }, null))

    const results = await Promise.all([
      kleora.getAccessToken({ force: true }),
      kleora.getAccessToken(),
      kleora.getAccessToken({ force: true }),
    ])

    expect(new Set(results).size).toBe(1)
    expect(issuer.calls.filter((call) => call.url === DISCOVERY.token_endpoint)).toHaveLength(2)
  })

  it('reports a forced refresh the issuer refuses as LoginRequired', async () => {
    const { issuer, kleora } = await signedIn()
    issuer.tokenResponses.push(() => json({ error: 'invalid_grant' }, 400))

    await expect(kleora.getAccessToken({ force: true })).rejects.toThrow(LoginRequired)
    expect(kleora.getUser()).toBeNull()
  })

  it('clears auth and announces the signed-out state when the issuer refuses', async () => {
    const { issuer, kleora } = await signedIn()
    const seen: AuthState[] = []
    kleora.onAuthChange((state) => seen.push(state))
    issuer.tokenResponses.push(() => json({ error: 'invalid_grant' }, 400))

    vi.setSystemTime(Date.now() + 900_000)
    await expect(kleora.getAccessToken()).rejects.toThrow(LoginRequired)

    expect(kleora.getUser()).toBeNull()
    expect(seen.at(-1)).toEqual({ user: null, isAuthenticated: false })
    expect(browser.session.snapshot()).toEqual({})

    vi.useRealTimers()
  })

  it.each([
    [
      'a 429 rate limit',
      () =>
        json(
          {
            type: 'https://kleora.io/problems/rate-limited',
            status: 429,
            detail: 'too many requests',
          },
          429,
          { 'Content-Type': 'application/problem+json', 'Retry-After': '30' },
        ),
      ApiError,
    ],
    [
      'a gateway answering HTML',
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      KleoraError,
    ],
    [
      'a transient 503 with no recognisable body',
      () => new Response('', { status: 503 }),
      KleoraError,
    ],
  ])('keeps the session through %s', async (_name, response, expected) => {
    // Only a refusal *with `invalid_grant`* clears state.
    // None of these says anything about the refresh token, and all of them
    // may have stopped being true by the next attempt.
    const { issuer, kleora } = await signedIn({ storage: 'session' })
    const seen: AuthState[] = []
    kleora.onAuthChange((state) => seen.push(state))
    issuer.tokenResponses.push(response)

    vi.setSystemTime(Date.now() + 900_000)
    await expect(kleora.getAccessToken()).rejects.toThrow(expected)

    expect(browser.session.getItem(`kleora:rt:${CLIENT_ID}`)).toBe('rt-1')
    expect(kleora.getUser()).not.toBeNull()
    expect(seen).toEqual([])

    // And the very next attempt succeeds, because nothing was thrown away.
    issuer.tokenResponses.push(() => tokens({ refresh_token: 'rt-2' }, null))
    await expect(kleora.getAccessToken()).resolves.toBeTypeOf('string')
    expect(browser.session.getItem(`kleora:rt:${CLIENT_ID}`)).toBe('rt-2')

    vi.useRealTimers()
  })

  it.each(['invalid_grant', 'invalid_client', 'invalid_scope'])(
    'ends the session on %s, which names the credential itself',
    async (error) => {
      const { issuer, kleora } = await signedIn({ storage: 'session' })
      const seen: AuthState[] = []
      kleora.onAuthChange((state) => seen.push(state))
      issuer.tokenResponses.push(() => json({ error }, 400))

      vi.setSystemTime(Date.now() + 900_000)
      await expect(kleora.getAccessToken()).rejects.toThrow(LoginRequired)

      expect(browser.session.getItem(`kleora:rt:${CLIENT_ID}`)).toBeNull()
      expect(seen).toEqual([{ user: null, isAuthenticated: false }])

      vi.useRealTimers()
    },
  )

  it('rethrows an invalid_request without ending the session, because that is our bug', async () => {
    const { issuer, kleora } = await signedIn({ storage: 'session' })
    issuer.tokenResponses.push(() => json({ error: 'invalid_request' }, 400))

    vi.setSystemTime(Date.now() + 900_000)
    await expect(kleora.getAccessToken()).rejects.toThrow(OAuthError)

    expect(browser.session.getItem(`kleora:rt:${CLIENT_ID}`)).toBe('rt-1')

    vi.useRealTimers()
  })

  it('announces nothing when a client that was never signed in asks for a token', async () => {
    scriptIssuer()
    const kleora = client()
    const seen: AuthState[] = []
    kleora.onAuthChange((state) => seen.push(state))

    await expect(kleora.getAccessToken()).rejects.toThrow(LoginRequired)
    await expect(kleora.getAccessToken()).rejects.toThrow(LoginRequired)

    expect(seen).toEqual([])
  })

  it('keeps the session when the network, not the issuer, is the problem', async () => {
    const { issuer, kleora } = await signedIn({ storage: 'session' })
    issuer.tokenResponses.push(() => {
      throw new TypeError('Failed to fetch')
    })

    vi.setSystemTime(Date.now() + 900_000)
    await expect(kleora.getAccessToken()).rejects.toThrow(
      expect.objectContaining({ code: 'network_error' }),
    )

    // The refresh token survives, so the next attempt can still work.
    issuer.tokenResponses.push(() => tokens({ refresh_token: 'rt-2' }, null))
    await expect(kleora.getAccessToken()).resolves.toBeTypeOf('string')

    vi.useRealTimers()
  })

  it('says which side failed: a readable 500 and a dead network are different sentences', async () => {
    // The two faults used to be indistinguishable from a browser, because
    // an older issuer's `500` from `/oauth/token` carried no
    // `Access-Control-Allow-Origin` and `fetch` therefore rejected with the
    // same `TypeError` a dead network produces. With the header on it the
    // response is readable, and this is what the SDK is then able to say —
    // asserted as a pair, because the value is in the difference.
    const { issuer, kleora } = await signedIn({ storage: 'session' })
    issuer.tokenResponses.push(
      () => new Response('<h1>Server Error (500)</h1>', { status: 500 }),
      () => {
        throw new TypeError('Failed to fetch')
      },
    )

    vi.setSystemTime(Date.now() + 900_000)
    const answered = await rejection(kleora.getAccessToken())
    const dead = await rejection(kleora.getAccessToken())

    expect(answered.code).toBe('server_error')
    expect(answered.message).toContain('the issuer answered 500')
    expect(dead.code).toBe('network_error')
    expect(dead.message).toContain('did not complete')
    expect(answered.message).not.toBe(dead.message)

    // Neither ends the session: a `500` may not hold a second from now.
    expect(browser.session.getItem(`kleora:rt:${CLIENT_ID}`)).toBe('rt-1')

    vi.useRealTimers()
  })

  it('still names an unrecognisable 4xx as one, rather than as a server fault', async () => {
    const { issuer, kleora } = await signedIn({ storage: 'session' })
    issuer.tokenResponses.push(() => new Response('nonsense', { status: 418 }))

    vi.setSystemTime(Date.now() + 900_000)
    await expect(kleora.getAccessToken()).rejects.toThrow(
      expect.objectContaining({ code: 'unexpected_response' }),
    )

    vi.useRealTimers()
  })

  it('reads a JSON server_error body as the OAuth error it is', async () => {
    // The status branch above is a fallback, not a shortcut past the body: an
    // issuer that answers RFC 6749 §5.2 JSON on a `5xx` keeps `error`
    // addressable, which is what the console's sign-in error page renders from.
    const { issuer, kleora } = await signedIn({ storage: 'session' })
    issuer.tokenResponses.push(() =>
      json({ error: 'server_error', error_description: 'the issuer failed' }, 500),
    )

    vi.setSystemTime(Date.now() + 900_000)
    const error = await rejection<OAuthError>(kleora.getAccessToken())

    expect(error).toBeInstanceOf(OAuthError)
    expect(error.error).toBe('server_error')
    expect(error.status).toBe(500)
    // And it is not terminal either: the refresh token is still there.
    expect(browser.session.getItem(`kleora:rt:${CLIENT_ID}`)).toBe('rt-1')

    vi.useRealTimers()
  })

  it('throws LoginRequired when there is no refresh token at all', async () => {
    scriptIssuer()
    const kleora = client()

    await expect(kleora.getAccessToken()).rejects.toThrow(LoginRequired)
  })
})

describe('logout', () => {
  it('clears local state before navigating to the end-session endpoint', async () => {
    const issuer = scriptIssuer()
    const kleora = client({ storage: 'session' })
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()
    const seen: AuthState[] = []
    kleora.onAuthChange((state) => seen.push(state))

    await kleora.logout({ returnTo: `${APP_ORIGIN}/goodbye` })
    const url = new URL(browser.location.navigations.at(-1) ?? '')

    expect(url.origin + url.pathname).toBe(DISCOVERY.end_session_endpoint)
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${APP_ORIGIN}/goodbye`)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('id_token_hint')).toBeTruthy()
    expect(kleora.getUser()).toBeNull()
    expect(seen.at(-1)).toEqual({ user: null, isAuthenticated: false })
    expect(browser.session.snapshot()).toEqual({})
  })

  it('navigates even when a subscriber throws, and does not announce a session that never was', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    const seen: AuthState[] = []
    kleora.onAuthChange(() => {
      throw new Error('a subscriber blew up')
    })
    kleora.onAuthChange((state) => seen.push(state))

    await expect(kleora.logout({ returnTo: `${APP_ORIGIN}/goodbye` })).resolves.toBeUndefined()

    expect(seen).toEqual([{ user: null, isAuthenticated: false }])
    expect(browser.location.navigations.at(-1)).toContain('/oauth/logout')
  })

  it('announces nothing when logging out a client that was never signed in', async () => {
    scriptIssuer()
    const kleora = client()
    const seen: AuthState[] = []
    kleora.onAuthChange((state) => seen.push(state))

    await kleora.logout({ returnTo: `${APP_ORIGIN}/goodbye` })

    expect(seen).toEqual([])
    expect(browser.location.navigations.at(-1)).toContain('/oauth/logout')
  })

  it('still navigates when there was never a session to end', async () => {
    scriptIssuer()
    const kleora = client()

    await kleora.logout({ returnTo: `${APP_ORIGIN}/goodbye` })
    const url = new URL(browser.location.navigations.at(-1) ?? '')

    expect(url.searchParams.has('id_token_hint')).toBe(false)
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
  })
})

describe('onAuthChange', () => {
  it('stops calling a subscriber that unsubscribed', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    const seen: AuthState[] = []
    const unsubscribe = kleora.onAuthChange((state) => seen.push(state))
    unsubscribe()

    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    expect(seen).toEqual([])
  })
})

/**
 * `hasLikelySession()` — the render hint. Its own storage semantics
 * are `session-marker.test.ts`'s job; this is only the wiring into the
 * client's own state transitions.
 */
describe('hasLikelySession', () => {
  it('is false before any sign-in', () => {
    expect(client().hasLikelySession()).toBe(false)
  })

  it('is set once a redirect callback is redeemed', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)

    await kleora.handleRedirectCallback()

    expect(kleora.hasLikelySession()).toBe(true)
    // The marker outlives this client instance — a fresh one over the same
    // origin storage (what a reload actually is) reads it too.
    expect(client().hasLikelySession()).toBe(true)
  })

  it('is set by a successful refresh', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()
    browser.local.clear() // as if this were a fresh client that never adopted a callback

    issuer.tokenResponses.push(() => tokens({}, null))
    await kleora.getAccessToken({ force: true })

    expect(kleora.hasLikelySession()).toBe(true)
  })

  it('is cleared by logout', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()
    expect(kleora.hasLikelySession()).toBe(true)

    await kleora.logout({ returnTo: `${APP_ORIGIN}/goodbye` })

    expect(kleora.hasLikelySession()).toBe(false)
  })

  it('is cleared when the issuer refuses a refresh outright (invalid_grant)', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    issuer.tokenResponses.push(() => json({ error: 'invalid_grant' }, 400))
    await expect(kleora.getAccessToken({ force: true })).rejects.toBeInstanceOf(LoginRequired)

    expect(kleora.hasLikelySession()).toBe(false)
  })

  it('survives a transient refresh failure — a 503 is not an authoritative refusal', async () => {
    const issuer = scriptIssuer()
    const kleora = client()
    issuer.tokenResponses.push(() => tokens())
    await landOnCallback(kleora)
    await kleora.handleRedirectCallback()

    issuer.tokenResponses.push(() => json({ error: 'temporarily_unavailable' }, 503))
    await expect(kleora.getAccessToken({ force: true })).rejects.toBeInstanceOf(OAuthError)

    // Only a refusal that names the credential ends the marker's
    // story, the same rule `refresh()` already applies to the refresh token
    // itself — a 503 leaves both exactly as valid as they were.
    expect(kleora.hasLikelySession()).toBe(true)
  })
})
