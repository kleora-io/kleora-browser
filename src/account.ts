/**
 * The end-user self-service API (`/account/v1/*`), typed.
 *
 * `/account/v1/*` on the issuer host, called with **the signed-in person's own
 * access token** — the one `getAccessToken()` already returns. Two things have
 * to be true for a call to succeed, and neither is this package's to decide:
 *
 * 1. **The Client lists `self_service` in `allowed_scopes`.** That list is the
 *    consent; a Client that has not opted in cannot be granted the
 *    scope, and its users cannot use this API or the hosted portal.
 * 2. **The token carries `self_service`.** The default `scope` of
 *    `createKleora` does not include it, so an application asks for it:
 *    `createKleora({ …, scope: 'openid profile email offline_access self_service' })`.
 *    Without it every call answers `403 insufficient-scope`.
 *
 * Every method is named for the operation, not the route, and every shape is
 * an alias into `generated/account.ts`, which `pnpm generate:client` writes
 * from the deployed OpenAPI document (`openapi/account-v1.json` is the committed
 * copy). Operations marked
 * **sensitive** answer `401 reauth-required` unless the person has
 * re-authenticated in the last five minutes — `reauthenticate({ password })`,
 * or the hosted portal's `/account/reauth` for a person with no password.
 *
 * Two things this API cannot do from a customer's origin, by a browser's rule
 * rather than ours: register a passkey and link a provider identity
 * (both ceremonies are bound to the issuer's origin). Send the person to the hosted portal
 * for those — `accountPortalUrl({ section: 'security' })`.
 */

import { fetchRef } from './browser.js'
import { parseAbsolute } from './environment.js'
import { ApiError, KleoraError } from './errors.js'
import type { components } from './generated/account.js'
import type { AccessTokenOptions } from './types.js'

type Schemas = components['schemas']

export type AccountProfile = Schemas['ProfileOut']
export type AccountProfileChanges = Schemas['ProfilePatch']
export type AccountEmail = Schemas['EmailOut']
export type AccountEmailSent = Schemas['ResendOut']
export type AccountPasswordPolicy = Schemas['PasswordPolicyOut']
export type AccountReauthentication = Schemas['ReauthOut']
export type AccountSession = Schemas['SessionOut']
export type AccountSessionPage = Schemas['SessionPage']
export type AccountSessionsRevoked = Schemas['RevokedOut']
export type AccountMfa = Schemas['MfaOut']
export type AccountMfaFactor = Schemas['MfaFactorOut']
export type AccountTotpEnrollment = Schemas['EnrollStartOut']
export type AccountRecoveryCodes = Schemas['RecoveryCodesOut']
export type AccountPasskeys = Schemas['PasskeysOut']
export type AccountPasskey = Schemas['PasskeyOut']
export type AccountIdentities = Schemas['IdentitiesOut']
export type AccountIdentity = Schemas['IdentityOut']
export type AccountSettings = Schemas['UserSettingsDocument']
export type AccountSetting = Schemas['UserSettingDocument']
export type AccountSettingValue = Schemas['UserSettingValue']
export type AccountPortal = Schemas['PortalOut']
export type AccountDeletion = Schemas['DeletionOut']
export type AccountProblem = Schemas['FlowProblem']
export type { components as AccountComponents } from './generated/account.js'

export interface AccountClientOptions {
  /** The Environment's issuer, e.g. `https://acme.kleora.eu`. */
  issuer: string
  /**
   * The signed-in person's access token — `kleora.getAccessToken` fits. It
   * is asked again with `{ force: true }` once, when the API answers `401
   * unauthenticated` for a token this client still believed in.
   */
  getAccessToken: (options?: AccessTokenOptions) => Promise<string>
}

export interface ListSessionsOptions {
  /** 1–200; the server's default is 50. */
  limit?: number
  /** `next_cursor` from the previous page. */
  cursor?: string
}

export interface ChangePasswordOptions {
  /** Required when the person has a password (`has_password`). Sensitive. */
  currentPassword?: string
  newPassword: string
}

/** Every `/account/v1/*` operation, named for what it does. */
export interface AccountClient {
  /** `GET /profile`. */
  getProfile(): Promise<AccountProfile>
  /** `PATCH /profile` — name, locale, picture; `null` clears one. */
  updateProfile(changes: AccountProfileChanges): Promise<AccountProfile>
  /** `GET /email` — the address, whether it is verified, and whether a change is pending. */
  getEmail(): Promise<AccountEmail>
  /** `POST /email` — mails a confirmation link to the new address. **Sensitive.** */
  requestEmailChange(email: string): Promise<AccountEmailSent>
  /** `POST /email/confirm` — the token from that link. */
  confirmEmailChange(token: string): Promise<void>
  /** `POST /email/resend` — the verification message, on the shared per-person budget. */
  resendVerificationEmail(): Promise<AccountEmailSent>
  /** `GET /password` — whether there is one, and the Environment's policy. */
  getPasswordPolicy(): Promise<AccountPasswordPolicy>
  /** `POST /password` — change it, or set one for a person who has none. **Sensitive.** */
  changePassword(options: ChangePasswordOptions): Promise<void>
  /** `GET /reauth` — what this person can re-authenticate with, and until when they have. */
  getReauthentication(): Promise<AccountReauthentication>
  /** `POST /reauth` — a password, and nothing else; opens the five-minute window. */
  reauthenticate(password: string): Promise<void>
  /** `GET /sessions` — live sessions, newest first, one cursor page. */
  listSessions(options?: ListSessionsOptions): Promise<AccountSessionPage>
  /** `DELETE /sessions/{id}` — may be the current one, which is a sign-out. */
  revokeSession(sessionId: string): Promise<void>
  /** `POST /sessions/revoke-others` — every live session but this token's. */
  revokeOtherSessions(): Promise<AccountSessionsRevoked>
  /** `GET /mfa`. */
  listMfaFactors(): Promise<AccountMfa>
  /** `POST /mfa/enroll/start` — a TOTP secret and its `otpauth://` URI. **Sensitive.** */
  startTotpEnrollment(): Promise<AccountTotpEnrollment>
  /** `POST /mfa/enroll/confirm` — the six digits; answers the recovery codes, once. **Sensitive.** */
  confirmTotpEnrollment(code: string): Promise<AccountRecoveryCodes>
  /** `DELETE /mfa/{id}`. **Sensitive.** */
  removeMfaFactor(factorId: string): Promise<void>
  /** `POST /mfa/recovery/regenerate` — new codes, shown once. **Sensitive.** */
  regenerateRecoveryCodes(): Promise<AccountRecoveryCodes>
  /** `GET /passkeys`. Registering one is hosted-only (the portal's security page). */
  listPasskeys(): Promise<AccountPasskeys>
  /** `DELETE /passkeys/{id}`. **Sensitive.** */
  removePasskey(passkeyId: string): Promise<void>
  /** `GET /identities`. Linking one is hosted-only (the portal's security page). */
  listIdentities(): Promise<AccountIdentities>
  /** `DELETE /identities/{id}`. **Sensitive.** */
  unlinkIdentity(identityId: string): Promise<void>
  /** `GET /settings` — the person's own settings, by access level. */
  listSettings(): Promise<AccountSettings>
  /** `PUT /settings/{key}`. */
  setSetting(key: string, value: AccountSettingValue): Promise<AccountSetting>
  /** `DELETE /settings/{key}` — back to the definition's default. */
  resetSetting(key: string): Promise<void>
  /** `GET /portal` — the hosted portal's entry URL and the sections this Environment offers. */
  getPortal(): Promise<AccountPortal>
  /** `POST /deletion` — deleted permanently after 7 days, cancellable until then. **Sensitive.** */
  requestDeletion(): Promise<AccountDeletion>
  /**
   * `DELETE /deletion` — the token from the emailed cancellation link. The one
   * anonymous operation: the request revoked every session, so no token is sent.
   */
  cancelDeletion(token: string): Promise<void>
}

interface Call {
  query?: Record<string, string | number | undefined>
  body?: unknown
  anonymous?: boolean
}

const PROBLEM_TYPE_UNAUTHENTICATED = /\/unauthenticated$/

/**
 * A client of `/account/v1/*` for the signed-in person.
 *
 * `credentials: 'omit'` on every request: the surface authenticates by bearer
 * only and never allows credentials cross-origin. A
 * browser reaches it from any origin that is a `redirect_uris` origin of a
 * Client of the Environment.
 */
export function createAccountClient(options: AccountClientOptions): AccountClient {
  const issuer = parseAbsolute('issuer', options.issuer)
  const base = `${issuer.href.replace(/\/+$/, '')}/account/v1`

  async function send(method: string, path: string, call: Call, force: boolean): Promise<Response> {
    const url = new URL(base + path)
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value))
    }
    const headers: Record<string, string> = { Accept: 'application/json, application/problem+json' }
    if (call.anonymous !== true) {
      const token = await options.getAccessToken(force ? { force: true } : undefined)
      headers['Authorization'] = `Bearer ${token}`
    }
    if (call.body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      return await fetchRef()(url.href, {
        method,
        headers,
        credentials: 'omit',
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      })
    } catch (cause) {
      throw new KleoraError(
        'network_error',
        `the request to ${url.href} did not complete: ${String(cause)}`,
      )
    }
  }

  async function request<T>(method: string, path: string, call: Call = {}): Promise<T> {
    let response = await send(method, path, call, false)
    let body = await parse(response)
    // One retry, with a forced refresh, and only for the refusal a new token
    // can cure. `session-revoked` and `reauth-required` are about the person,
    // not the token, and a fresh token would be refused the same way.
    if (response.status === 401 && call.anonymous !== true && isUnauthenticated(body)) {
      response = await send(method, path, call, true)
      body = await parse(response)
    }
    if (!response.ok) throw toError(response, body)
    return (response.status === 204 ? undefined : body) as T
  }

  const id = (value: string): string => encodeURIComponent(value)

  return {
    getProfile: () => request('GET', '/profile'),
    updateProfile: (changes) => request('PATCH', '/profile', { body: changes }),
    getEmail: () => request('GET', '/email'),
    requestEmailChange: (email) => request('POST', '/email', { body: { email } }),
    confirmEmailChange: (token) => request('POST', '/email/confirm', { body: { token } }),
    resendVerificationEmail: () => request('POST', '/email/resend'),
    getPasswordPolicy: () => request('GET', '/password'),
    changePassword: ({ currentPassword, newPassword }) =>
      request('POST', '/password', {
        body: {
          new_password: newPassword,
          ...(currentPassword === undefined ? {} : { current_password: currentPassword }),
        },
      }),
    getReauthentication: () => request('GET', '/reauth'),
    reauthenticate: (password) => request('POST', '/reauth', { body: { password } }),
    listSessions: (list = {}) =>
      request('GET', '/sessions', { query: { limit: list.limit, cursor: list.cursor } }),
    revokeSession: (sessionId) => request('DELETE', `/sessions/${id(sessionId)}`),
    revokeOtherSessions: () => request('POST', '/sessions/revoke-others'),
    listMfaFactors: () => request('GET', '/mfa'),
    startTotpEnrollment: () => request('POST', '/mfa/enroll/start'),
    confirmTotpEnrollment: (code) => request('POST', '/mfa/enroll/confirm', { body: { code } }),
    removeMfaFactor: (factorId) => request('DELETE', `/mfa/${id(factorId)}`),
    regenerateRecoveryCodes: () => request('POST', '/mfa/recovery/regenerate'),
    listPasskeys: () => request('GET', '/passkeys'),
    removePasskey: (passkeyId) => request('DELETE', `/passkeys/${id(passkeyId)}`),
    listIdentities: () => request('GET', '/identities'),
    unlinkIdentity: (identityId) => request('DELETE', `/identities/${id(identityId)}`),
    listSettings: () => request('GET', '/settings'),
    setSetting: (key, value) => request('PUT', `/settings/${id(key)}`, { body: { value } }),
    resetSetting: (key) => request('DELETE', `/settings/${id(key)}`),
    getPortal: () => request('GET', '/portal'),
    requestDeletion: () => request('POST', '/deletion'),
    cancelDeletion: (token) =>
      request('DELETE', '/deletion', { body: { token }, anonymous: true }),
  }
}

async function parse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function isUnauthenticated(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  const type = (body as Record<string, unknown>)['type']
  return typeof type === 'string' && PROBLEM_TYPE_UNAUTHENTICATED.test(type)
}

/**
 * An RFC 9457 problem as `ApiError`, and a bodiless failure as what it is.
 *
 * Every refusal on this surface is a problem document carrying `type` —
 * `…/reauth-required`, `…/insufficient-scope`, `…/session-revoked` — which is
 * what a caller branches on.
 */
function toError(response: Response, body: unknown): KleoraError {
  const document =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  if (document !== null && typeof document['type'] === 'string') {
    const errors = document['errors']
    return new ApiError(
      document['type'],
      response.status,
      typeof document['detail'] === 'string' ? document['detail'] : undefined,
      Array.isArray(errors) ? (errors as unknown[]) : undefined,
    )
  }
  if (response.status >= 500) {
    return new KleoraError(
      'server_error',
      `the issuer answered ${String(response.status)}: the request reached it and failed there`,
    )
  }
  return new KleoraError(
    'unexpected_response',
    `the account API answered ${String(response.status)} with no recognisable error body`,
  )
}
