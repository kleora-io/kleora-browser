/**
 * `kleora.account` and `accountPortalUrl` against a running Kleora deployment.
 *
 * A credential is proved by using it. So this
 * signs a person in **through the SDK** — `loginWithRedirect`, the hosted pages,
 * `handleRedirectCallback` — with `self_service` in the scope, and then changes
 * that person's password with the token the SDK holds, and signs in again with
 * the new one. The same run proves the requirement the SDK documents: before
 * the Client lists `self_service`, the issuer refuses to grant it.
 *
 * It provisions an App of its own (as `@kleora-io/node`'s contract suite does) and
 * deletes it afterwards, so the `id` App the console signs in through is never
 * touched. Needs the same `KLEORA_TEST_*` as `oauth.contract.test.ts`, plus
 * `KLEORA_TEST_API_BASE`. Not run in CI; see the README.
 */
import { randomBytes } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createKleora } from '../../src/client.js'
import { ApiError, OAuthError } from '../../src/errors.js'
import { accountPortalUrl } from '../../src/portal.js'
import { installFakeBrowser } from '../fake-browser.js'
import { driveHostedLogin } from './hosted-login.js'

const ISSUER = process.env['KLEORA_TEST_ISSUER']
const CLIENT_ID = process.env['KLEORA_TEST_CLIENT_ID']
const API_BASE = process.env['KLEORA_TEST_API_BASE']
const REDIRECT_URI = process.env['KLEORA_TEST_REDIRECT_URI'] ?? 'http://localhost:6101/auth/callback'
const USERNAME = process.env['KLEORA_TEST_USERNAME']
const PASSWORD = process.env['KLEORA_TEST_PASSWORD']

const configured =
  ISSUER !== undefined &&
  CLIENT_ID !== undefined &&
  API_BASE !== undefined &&
  USERNAME !== undefined &&
  PASSWORD !== undefined
const required = process.env['KLEORA_TEST_REQUIRE_LIVE'] === '1'

const SELF_SERVICE_SCOPE = 'openid profile email offline_access self_service'
/** An origin the provisioned Client registers — the customer's application. */
const APP_ORIGIN = new URL(REDIRECT_URI).origin

interface Provisioned {
  appId: string
  issuer: string
  environmentId: string
  clientRowId: string
  clientId: string
  allowedScopes: string[]
  email: string
  password: string
  admin: <T>(method: string, path: string, body?: unknown) => Promise<T>
}

let stack: Provisioned | undefined

function apiOrigin(): string {
  const base = (API_BASE ?? '').replace(/\/+$/, '')
  return base.endsWith('/api/v1') ? base.slice(0, -'/api/v1'.length) : base
}

/** Sign `email` in through the SDK, as an application would, and return the client. */
async function signIn(issuer: string, clientId: string, email: string, password: string, scope: string) {
  installFakeBrowser(`${APP_ORIGIN}/`)
  const kleora = createKleora({ issuer, clientId, redirectUri: REDIRECT_URI, scope })
  await kleora.loginWithRedirect()
  const authorize = String((globalThis as unknown as { location: { navigations: string[] } }).location.navigations.at(-1))
  const landing = await driveHostedLogin(authorize, REDIRECT_URI, { email, password })
  ;(globalThis as unknown as { location: { href: string } }).location.href = landing.href
  await kleora.handleRedirectCallback()
  return kleora
}

async function provision(): Promise<Provisioned> {
  const owner = await signIn(ISSUER as string, CLIENT_ID as string, USERNAME as string, PASSWORD as string, 'openid profile email offline_access')
  const bearer = await owner.getAccessToken()
  const admin = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(apiOrigin() + path, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${method} ${path} answered ${String(response.status)}: ${text}`)
    return (text === '' ? undefined : JSON.parse(text)) as T
  }

  const suffix = randomBytes(4).toString('hex')
  const app = await admin<{ id: string; environments: { id: string; kind: string; issuer: string }[] }>(
    'POST',
    '/api/v1/apps',
    { name: `sdk browser ${suffix}`, slug: `sdkbrowser${suffix}` },
  )
  const sandbox = app.environments.find((environment) => environment.kind === 'sandbox')
  if (sandbox === undefined) throw new Error('a new App did not come with a sandbox')
  const clients = await admin<{ items: { id: string; client_id: string; is_default: boolean; allowed_scopes: string[] }[] }>(
    'GET',
    `/api/v1/environments/${sandbox.id}/clients`,
  )
  const client = clients.items.find((row) => row.is_default)
  if (client === undefined) throw new Error('the sandbox has no default client')
  await admin('PATCH', `/api/v1/environments/${sandbox.id}/clients/${client.id}`, {
    redirect_uris: [REDIRECT_URI],
    post_logout_redirect_uris: [`${APP_ORIGIN}/`],
  })
  const email = `sdk-browser-${suffix}@example.test`
  const password = randomBytes(24).toString('base64url')
  await admin('POST', `/api/v1/environments/${sandbox.id}/users`, {
    email,
    password,
    email_verified: true,
    send_verification: false,
  })
  return {
    appId: app.id,
    issuer: sandbox.issuer,
    environmentId: sandbox.id,
    clientRowId: client.id,
    clientId: client.client_id,
    allowedScopes: client.allowed_scopes,
    email,
    password,
    admin,
  }
}

describe.runIf(required)('the account contract environment', () => {
  it('is configured, because this run required it', () => {
    expect(configured).toBe(true)
  })
})

describe.skipIf(!configured)('kleora.account against a running stack', () => {
  beforeAll(async () => {
    stack = await provision()
  }, 90_000)

  afterAll(async () => {
    if (stack !== undefined) await stack.admin('DELETE', `/api/v1/apps/${stack.appId}`)
  })

  beforeEach(() => {
    installFakeBrowser(`${APP_ORIGIN}/`)
  })

  it('is refused self_service until the Client lists it — the consent the SDK documents', async () => {
    const s = stack as Provisioned
    installFakeBrowser(`${APP_ORIGIN}/`)
    const kleora = createKleora({ issuer: s.issuer, clientId: s.clientId, redirectUri: REDIRECT_URI, scope: SELF_SERVICE_SCOPE })
    await kleora.loginWithRedirect()
    const authorize = String((globalThis as unknown as { location: { navigations: string[] } }).location.navigations.at(-1))
    // A scope not allowed for the Client is a
    // redirect `invalid_scope`, before anybody is asked for a password.
    const landing = await driveHostedLogin(authorize, REDIRECT_URI, { email: s.email, password: s.password })
    expect(landing.searchParams.get('error')).toBe('invalid_scope')
    ;(globalThis as unknown as { location: { href: string } }).location.href = landing.href
    const refusal = await kleora.handleRedirectCallback().catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(OAuthError)
    expect((refusal as OAuthError).error).toBe('invalid_scope')
  }, 60_000)

  it('changes the person’s password with the token the SDK holds, and the new one signs in', async () => {
    const s = stack as Provisioned
    await s.admin('PATCH', `/api/v1/environments/${s.environmentId}/clients/${s.clientRowId}`, {
      allowed_scopes: [...s.allowedScopes, 'self_service'],
    })
    const kleora = await signIn(s.issuer, s.clientId, s.email, s.password, SELF_SERVICE_SCOPE)

    const profile = await kleora.account.getProfile()
    expect(profile.email).toBe(s.email)
    expect(profile.has_password).toBe(true)

    // Sensitive: refused until the person re-authenticates.
    const refused = await kleora.account
      .changePassword({ currentPassword: s.password, newPassword: 'x' })
      .catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ApiError)
    expect((refused as ApiError).type).toMatch(/\/reauth-required$/)

    await kleora.account.reauthenticate(s.password)
    expect((await kleora.account.getReauthentication()).reauthenticated_until).toBeTruthy()
    const next = randomBytes(24).toString('base64url')
    await kleora.account.changePassword({ currentPassword: s.password, newPassword: next })

    const sessions = await kleora.account.listSessions()
    expect(sessions.items.filter((row) => row.current)).toHaveLength(1)

    const portal = await kleora.account.getPortal()
    expect(portal.url).toBe(`${s.issuer}/account`)
    expect(portal.sections).toContain('security')

    // The credential the change produced is the one that works now.
    const again = await signIn(s.issuer, s.clientId, s.email, next, SELF_SERVICE_SCOPE)
    expect((await again.account.getProfile()).email).toBe(s.email)
    s.password = next
  }, 90_000)

  it('is readable from the application’s origin, and not from anybody else’s', async () => {
    const s = stack as Provisioned
    const kleora = await signIn(s.issuer, s.clientId, s.email, s.password, SELF_SERVICE_SCOPE)
    const token = await kleora.getAccessToken()
    const read = (origin: string) =>
      fetch(`${s.issuer}/account/v1/profile`, { headers: { Authorization: `Bearer ${token}`, Origin: origin } })

    const ours = await read(APP_ORIGIN)
    expect(ours.status).toBe(200)
    expect(ours.headers.get('access-control-allow-origin')).toBe(APP_ORIGIN)
    expect(ours.headers.get('access-control-allow-credentials')).toBeNull()
    const theirs = await read('https://elsewhere.example')
    expect(theirs.headers.get('access-control-allow-origin')).toBeNull()
  }, 60_000)

  it('builds a portal URL the issuer serves', async () => {
    const s = stack as Provisioned
    const url = accountPortalUrl({ issuer: s.issuer, clientId: s.clientId, section: 'sessions', returnTo: `${APP_ORIGIN}/` })
    const response = await fetch(url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })
})
