/**
 * The SDK against a running environment.
 *
 * These tests are the ones that would catch the package agreeing with itself:
 * the unit suite scripts the issuer, so it can only prove that the client
 * does what this package *believes* the endpoints do. Here the endpoints
 * answer for themselves.
 *
 * They skip when `KLEORA_TEST_ISSUER` and `KLEORA_TEST_CLIENT_ID` are
 * absent, so `pnpm test` stays green without a deployment; the full
 * round trip additionally needs `KLEORA_TEST_USERNAME` and
 * `KLEORA_TEST_PASSWORD`, and skips on its own without them.
 *
 * Not run in CI. To run them, point them at an environment you own:
 *
 * ```
 * KLEORA_TEST_ISSUER=https://<your-app>-sandbox.<issuer-domain> \
 * KLEORA_TEST_CLIENT_ID=<client id> \
 * KLEORA_TEST_REDIRECT_URI=<a registered redirect URI> \
 * KLEORA_TEST_USERNAME=<a test user's email> \
 * KLEORA_TEST_PASSWORD=<their password> \
 * pnpm test
 * ```
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { createKleora } from '../../src/client.js'
import { EnvironmentMismatch, OAuthError } from '../../src/errors.js'
import { installFakeBrowser, type FakeBrowser } from '../fake-browser.js'
import { driveHostedLogin } from './hosted-login.js'

const ISSUER = process.env['KLEORA_TEST_ISSUER']
const CLIENT_ID = process.env['KLEORA_TEST_CLIENT_ID']
const REDIRECT_URI = process.env['KLEORA_TEST_REDIRECT_URI'] ?? 'http://localhost:6101/auth/callback'
const USERNAME = process.env['KLEORA_TEST_USERNAME']
const PASSWORD = process.env['KLEORA_TEST_PASSWORD']

const configured = ISSUER !== undefined && CLIENT_ID !== undefined
const credentialled = configured && USERNAME !== undefined && PASSWORD !== undefined

/** See the node package's `stack.ts`: CI sets this when a silent skip is a bug. */
const required = process.env['KLEORA_TEST_REQUIRE_LIVE'] === '1'

let browser: FakeBrowser

function client(overrides: Record<string, unknown> = {}) {
  return createKleora({
    issuer: ISSUER ?? '',
    clientId: CLIENT_ID ?? '',
    redirectUri: REDIRECT_URI,
    ...overrides,
  })
}

describe.runIf(required)('the contract environment', () => {
  it('is configured and credentialled, because this run required it', () => {
    expect(configured).toBe(true)
    expect(credentialled).toBe(true)
  })
})

describe.skipIf(!configured)('@kleora-io/browser against a running environment', () => {
  beforeEach(() => {
    browser = installFakeBrowser(new URL(REDIRECT_URI).origin + '/')
  })

  it('discovers the endpoints and accepts the issuer it was configured with', async () => {
    const kleora = client()

    await kleora.loginWithRedirect()
    const authorize = new URL(browser.location.navigations.at(-1) ?? '')

    expect(authorize.href.startsWith(`${ISSUER ?? ''}/oauth/authorize`)).toBe(true)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID)
  })

  it('does not adopt a host that is not an issuer of this deployment', async () => {
    // The `Host` header selects the environment and an unknown one
    // is a 404. The client must fail rather than carry on with endpoints it
    // guessed — which is the same protection the EnvironmentMismatch guard
    // gives when a host *does* answer with another environment's document.
    const real = new URL(ISSUER ?? '')
    const kleora = createKleora({
      issuer: `${real.protocol}//127.0.0.1:${real.port}`,
      clientId: CLIENT_ID ?? '',
      redirectUri: REDIRECT_URI,
    })

    await expect(kleora.loginWithRedirect()).rejects.toThrow(
      expect.objectContaining({ code: 'discovery_unreachable' }),
    )
  })

  it('names itself in its own discovery document, which is what the guard rests on', async () => {
    const document = (await (await fetch(`${ISSUER ?? ''}/.well-known/openid-configuration`)).json()) as {
      issuer: string
      token_endpoint: string
    }

    expect(document.issuer).toBe(ISSUER)
    expect(document.token_endpoint).toBe(`${ISSUER ?? ''}/oauth/token`)

    // And the sandbox host of the same deployment is a different issuer, so
    // the two cannot be confused for one another.
    const sandbox = new URL(ISSUER ?? '')
    sandbox.hostname = sandbox.hostname.replace('.', '-sandbox.')
    const other = await fetch(`${sandbox.origin}/.well-known/openid-configuration`)
    if (other.ok) {
      expect(((await other.json()) as { issuer: string }).issuer).toBe(sandbox.origin)
      expect(() =>
        createKleora({
          issuer: ISSUER ?? '',
          clientId: CLIENT_ID ?? '',
          redirectUri: `${sandbox.origin}/auth/callback`,
        }),
      ).toThrow(EnvironmentMismatch)
    }
  })

  it('surfaces the token endpoint’s RFC 6749 §5.2 refusal as an OAuthError', async () => {
    const kleora = client()

    await kleora.loginWithRedirect()
    const authorize = new URL(browser.location.navigations.at(-1) ?? '')
    const callback = new URL(REDIRECT_URI)
    callback.searchParams.set('code', 'not-a-code-this-environment-ever-issued')
    callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
    callback.searchParams.set('iss', ISSUER ?? '')
    browser.location.href = callback.href

    await expect(kleora.handleRedirectCallback()).rejects.toThrow(
      expect.objectContaining({ error: 'invalid_grant' }),
    )
    // And the dead code is out of the address bar either way.
    expect(browser.location.href).toBe(new URL(REDIRECT_URI).href)
  })

  it('lets the redirect origin read the token endpoint, and answers no-store', async () => {
    // CORS. The SDK's `fetch` lives or dies by this header:
    // without it the browser refuses the response before the SDK sees it.
    const origin = new URL(REDIRECT_URI).origin
    const registered = await refuse(origin)

    expect(registered.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(registered.headers.get('Vary')).toBe('Origin')
    expect(registered.headers.get('Cache-Control')).toBe('no-store')
    expect(await registered.json()).toMatchObject({ error: 'invalid_grant' })

    // The negative half, unconditionally. It used to be skipped when the
    // header came back `*`, which a development deployment used to answer —
    // so the one assertion that matters never ran against the stack it was
    // pointed at. The token endpoint computes CORS per client on every
    // deployment now, development included, so an unregistered origin gets no header anywhere.
    const stranger = await refuse('https://not-a-registered-origin.example')
    expect(stranger.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  describe.skipIf(!credentialled)('full round trip', () => {
    it('logs in, redeems the code, refreshes with rotation and logs out', async () => {
      const kleora = client({ storage: 'session' })
      const states: unknown[] = []
      kleora.onAuthChange((state) => states.push(state))

      await kleora.loginWithRedirect({ returnTo: '/dashboard', appState: { via: 'contract' } })
      const authorize = browser.location.navigations.at(-1) ?? ''

      const landing = await driveHostedLogin(authorize, REDIRECT_URI, {
        email: USERNAME ?? '',
        password: PASSWORD ?? '',
      })
      expect(landing.searchParams.get('iss')).toBe(ISSUER)
      browser.location.href = landing.href

      const result = await kleora.handleRedirectCallback()

      expect(result.appState).toMatchObject({ returnTo: '/dashboard', via: 'contract' })
      expect(kleora.getUser()?.sub).toBeTruthy()
      // The credentials are gone from the address bar.
      expect(browser.location.href).toBe(new URL(REDIRECT_URI).href)

      const first = await kleora.getAccessToken()
      expect(first).toBe(await kleora.getAccessToken())

      // Rotation: the stored refresh token is replaced, and the spent one is
      // refused.
      const key = `kleora:rt:${CLIENT_ID ?? ''}`
      const spent = browser.session.getItem(key)
      expect(spent).toBeTruthy()

      const rotated = await refreshDirectly(spent ?? '')
      expect(rotated.refresh_token).not.toBe(spent)
      await expect(refreshDirectly(spent ?? '')).rejects.toThrow(OAuthError)

      await kleora.logout({ returnTo: new URL(REDIRECT_URI).origin + '/' })
      expect(kleora.getUser()).toBeNull()
      expect(browser.session.getItem(key)).toBeNull()
      expect(browser.location.navigations.at(-1)).toContain('/oauth/logout')
      expect(states.at(-1)).toEqual({ user: null, isAuthenticated: false })
    })
  })
})

/** A deliberately doomed token request, used to read response headers. */
async function refuse(origin: string): Promise<Response> {
  return fetch(`${ISSUER ?? ''}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'not-a-token',
      client_id: CLIENT_ID ?? '',
    }).toString(),
  })
}

/** The rotation half of the round trip, driven without the SDK's cache. */
async function refreshDirectly(refreshToken: string): Promise<{ refresh_token?: string }> {
  const response = await fetch(`${ISSUER ?? ''}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID ?? '',
    }).toString(),
  })
  const body = (await response.json()) as Record<string, unknown>
  if (!response.ok) {
    throw new OAuthError(String(body['error']), undefined, response.status)
  }
  return body
}
