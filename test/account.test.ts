/**
 * The typed self-service client (`/account/v1/*`).
 *
 * The wire is scripted here; `contract/account.contract.test.ts` is the same
 * client against a running issuer.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createAccountClient } from '../src/account.js'
import { createKleora } from '../src/client.js'
import { ApiError, KleoraError } from '../src/errors.js'
import { installFakeBrowser, installFetch, json } from './fake-browser.js'

const ISSUER = 'https://acme.kleora.eu'
const BASE = `${ISSUER}/account/v1`

function problem(slug: string, status: number): Response {
  return new Response(
    JSON.stringify({ type: `https://kleora.io/problems/${slug}`, status, title: slug, code: slug }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  )
}

function account(tokens: string[] = ['t1', 't2']) {
  const getAccessToken = vi.fn((options?: { force?: boolean }) =>
    Promise.resolve(options?.force === true ? (tokens[1] ?? 'forced') : (tokens[0] ?? 'token')),
  )
  return { client: createAccountClient({ issuer: `${ISSUER}/`, getAccessToken }), getAccessToken }
}

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  (init?.headers ?? {}) as Record<string, string>

const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined

/**
 * No generator carries `x-kleora-sensitive` into this package, so the
 * `**Sensitive.**` notes in `src/account.ts` are hand-written prose and this is
 * the one thing holding them to the committed document. Every doc comment that
 * opens with a backticked route is one operation, and the note is its claim.
 */
const ROUTE_COMMENT = /\/\*\*([\s\S]*?)\*\//g
const ROUTE = /^[\s*]*`(GET|POST|PUT|PATCH|DELETE) (\/[^`]*)`/
const SENSITIVE_NOTE = '**Sensitive.**'
const placeholders = (path: string): string => path.replace(/\{[^}]*\}/g, '{}')

function claimedSensitivity(source: string): Record<string, boolean> {
  const claims: Record<string, boolean> = {}
  for (const [, comment = ''] of source.matchAll(ROUTE_COMMENT)) {
    const route = ROUTE.exec(comment)
    if (route === null) continue
    claims[`${route[1] ?? ''} ${placeholders(route[2] ?? '')}`] = comment.includes(SENSITIVE_NOTE)
  }
  return claims
}

function declaredSensitivity(): Record<string, unknown> {
  const document = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../openapi/account-v1.json'), 'utf8'),
  ) as { paths: Record<string, Record<string, Record<string, unknown>>> }
  const declared: Record<string, unknown> = {}
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      declared[`${method.toUpperCase()} ${placeholders(path.replace('/account/v1', ''))}`] =
        operation['x-kleora-sensitive']
    }
  }
  return declared
}

describe('createAccountClient', () => {
  it('sends the person’s bearer token, omits credentials, and returns the typed body', async () => {
    const fetch = installFetch(() => json({ email: 'a@example.test', has_password: true }))
    const { client } = account()

    const profile = await client.getProfile()

    expect(profile.email).toBe('a@example.test')
    expect(fetch.calls[0]?.url).toBe(`${BASE}/profile`)
    expect(fetch.calls[0]?.init?.method).toBe('GET')
    expect(fetch.calls[0]?.init?.credentials).toBe('omit')
    expect(headersOf(fetch.calls[0]?.init)['Authorization']).toBe('Bearer t1')
  })

  // One row per operation: the name, the call, the method and path it must reach, and the body.
  const operations: [string, (c: ReturnType<typeof account>['client']) => Promise<unknown>, string, string, unknown][] = [
    ['updateProfile', (c) => c.updateProfile({ name: 'Ada' }), 'PATCH', '/profile', { name: 'Ada' }],
    ['getEmail', (c) => c.getEmail(), 'GET', '/email', undefined],
    ['requestEmailChange', (c) => c.requestEmailChange('n@example.test'), 'POST', '/email', { email: 'n@example.test' }],
    ['confirmEmailChange', (c) => c.confirmEmailChange('tok'), 'POST', '/email/confirm', { token: 'tok' }],
    ['resendVerificationEmail', (c) => c.resendVerificationEmail(), 'POST', '/email/resend', undefined],
    ['getPasswordPolicy', (c) => c.getPasswordPolicy(), 'GET', '/password', undefined],
    ['changePassword', (c) => c.changePassword({ currentPassword: 'old', newPassword: 'new' }), 'POST', '/password', { new_password: 'new', current_password: 'old' }],
    ['changePassword, setting one', (c) => c.changePassword({ newPassword: 'new' }), 'POST', '/password', { new_password: 'new' }],
    ['getReauthentication', (c) => c.getReauthentication(), 'GET', '/reauth', undefined],
    ['reauthenticate', (c) => c.reauthenticate('pw'), 'POST', '/reauth', { password: 'pw' }],
    ['listSessions', (c) => c.listSessions(), 'GET', '/sessions', undefined],
    ['listSessions, paged', (c) => c.listSessions({ limit: 10, cursor: 'abc' }), 'GET', '/sessions?limit=10&cursor=abc', undefined],
    ['revokeSession', (c) => c.revokeSession('s/1'), 'DELETE', '/sessions/s%2F1', undefined],
    ['revokeOtherSessions', (c) => c.revokeOtherSessions(), 'POST', '/sessions/revoke-others', undefined],
    ['listMfaFactors', (c) => c.listMfaFactors(), 'GET', '/mfa', undefined],
    ['startTotpEnrollment', (c) => c.startTotpEnrollment(), 'POST', '/mfa/enroll/start', undefined],
    ['confirmTotpEnrollment', (c) => c.confirmTotpEnrollment('123456'), 'POST', '/mfa/enroll/confirm', { code: '123456' }],
    ['removeMfaFactor', (c) => c.removeMfaFactor('f1'), 'DELETE', '/mfa/f1', undefined],
    ['regenerateRecoveryCodes', (c) => c.regenerateRecoveryCodes(), 'POST', '/mfa/recovery/regenerate', undefined],
    ['listPasskeys', (c) => c.listPasskeys(), 'GET', '/passkeys', undefined],
    ['removePasskey', (c) => c.removePasskey('p1'), 'DELETE', '/passkeys/p1', undefined],
    ['listIdentities', (c) => c.listIdentities(), 'GET', '/identities', undefined],
    ['unlinkIdentity', (c) => c.unlinkIdentity('i1'), 'DELETE', '/identities/i1', undefined],
    ['listSettings', (c) => c.listSettings(), 'GET', '/settings', undefined],
    ['setSetting', (c) => c.setSetting('theme', 'dark'), 'PUT', '/settings/theme', { value: 'dark' }],
    ['resetSetting', (c) => c.resetSetting('theme'), 'DELETE', '/settings/theme', undefined],
    ['getPortal', (c) => c.getPortal(), 'GET', '/portal', undefined],
    ['requestDeletion', (c) => c.requestDeletion(), 'POST', '/deletion', undefined],
  ]

  it.each(operations)('%s reaches its route', async (_, run, method, path, body) => {
    const fetch = installFetch(() => json({}))
    await run(account().client)
    const init = fetch.calls[0]?.init
    expect(fetch.calls[0]?.url).toBe(`${BASE}${path}`)
    expect(init?.method).toBe(method)
    expect(bodyOf(init)).toEqual(body)
    if (body !== undefined) expect(headersOf(init)['Content-Type']).toBe('application/json')
  })

  it('covers every operation the document declares', async () => {
    const document = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../openapi/account-v1.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> }
    const declared = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => `${method.toUpperCase()} ${path.replace('/account/v1', '')}`),
    )
    const reached = new Set<string>()
    const fetch = installFetch(() => json({}))
    const client = account().client
    for (const [, run] of operations) await run(client)
    await client.getProfile()
    await client.cancelDeletion('t')
    for (const call of fetch.calls) {
      const path = new URL(call.url).pathname.replace('/account/v1', '')
      reached.add(`${String(call.init?.method)} ${path}`)
    }
    const normalised = [...reached].map((route) =>
      route
        .replace(/\/sessions\/s%2F1$/, '/sessions/{session_id}')
        .replace(/\/mfa\/f1$/, '/mfa/{factor_id}')
        .replace(/\/passkeys\/p1$/, '/passkeys/{factor_id}')
        .replace(/\/identities\/i1$/, '/identities/{identity_id}')
        .replace(/\/settings\/theme$/, '/settings/{key}'),
    )
    expect(new Set(normalised)).toEqual(new Set(declared))
  })

  it('marks **Sensitive.** on exactly the operations the document marks x-kleora-sensitive', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/account.ts'), 'utf8')
    const claimed = claimedSensitivity(source)
    expect(claimed).toEqual(declaredSensitivity())
    // A note that drifted off its route's comment would be counted by nobody.
    expect(source.split(SENSITIVE_NOTE).length - 1).toBe(Object.values(claimed).filter(Boolean).length)
  })

  it('cancels a deletion anonymously: no token is asked for or sent', async () => {
    const fetch = installFetch(() => new Response(null, { status: 204 }))
    const { client, getAccessToken } = account()
    await expect(client.cancelDeletion('mailed')).resolves.toBeUndefined()
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(headersOf(fetch.calls[0]?.init)['Authorization']).toBeUndefined()
    expect(bodyOf(fetch.calls[0]?.init)).toEqual({ token: 'mailed' })
  })

  it('answers undefined for a 204', async () => {
    installFetch(() => new Response(null, { status: 204 }))
    await expect(account().client.reauthenticate('pw')).resolves.toBeUndefined()
  })

  it('retries once with a forced token on 401 unauthenticated', async () => {
    let first = true
    const fetch = installFetch(() => {
      if (first) {
        first = false
        return problem('unauthenticated', 401)
      }
      return json({ email: 'a@example.test' })
    })
    const { client, getAccessToken } = account()
    await expect(client.getProfile()).resolves.toEqual({ email: 'a@example.test' })
    expect(getAccessToken).toHaveBeenLastCalledWith({ force: true })
    expect(headersOf(fetch.calls[1]?.init)['Authorization']).toBe('Bearer t2')
  })

  it.each(['reauth-required', 'session-revoked'])(
    'does not retry %s, which no new token can cure, and surfaces it as ApiError',
    async (slug) => {
      const fetch = installFetch(() => problem(slug, 401))
      const error = await account().client.changePassword({ newPassword: 'x' }).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).type).toBe(`https://kleora.io/problems/${slug}`)
      expect((error as ApiError).status).toBe(401)
      expect(fetch.calls).toHaveLength(1)
    },
  )

  it('names a token without self_service by its problem type', async () => {
    installFetch(() => problem('insufficient-scope', 403))
    const error = await account().client.getProfile().catch((e: unknown) => e)
    expect((error as ApiError).type).toBe('https://kleora.io/problems/insufficient-scope')
  })

  it('tells a bodiless 5xx and a dead network apart', async () => {
    installFetch(() => new Response('<html>', { status: 502 }))
    expect(await account().client.getProfile().catch((e: unknown) => (e as KleoraError).code)).toBe(
      'server_error',
    )
    installFetch(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await account().client.getProfile().catch((e: unknown) => (e as KleoraError).code)).toBe(
      'network_error',
    )
  })
})

describe('kleora.account', () => {
  it('is one client over the issuer and this client’s own token', async () => {
    installFakeBrowser('https://app.example.com/')
    const kleora = createKleora({
      issuer: ISSUER,
      clientId: 'cl_app',
      redirectUri: 'https://app.example.com/callback',
    })
    expect(kleora.account).toBe(kleora.account)
    // Signed out: the token the client would send does not exist, and the call
    // says so rather than sending a request without one.
    installFetch(() => json({}))
    await expect(kleora.account.getProfile()).rejects.toMatchObject({ code: 'login_required' })
  })
})
