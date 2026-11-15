/**
 * `createKleora` — the whole public surface of the package.
 *
 * The flow it implements is the authorization code grant with PKCE from a
 * single-page application, step for step: mint a verifier and a `state`, navigate,
 * check `state` and `iss` on the way back, redeem the code, validate the ID
 * token, keep the access token in memory and rotate the refresh token before
 * the access token expires.
 */

import { createAccountClient, type AccountClient } from './account.js'
import { fetchRef, historyRef, locationRef, openRef } from './browser.js'
import { createDiscovery } from './discovery.js'
import { assertSameEnvironment, assertTokenEnvironment, parseAbsolute } from './environment.js'
import { EnvironmentMismatch, LoginRequired, OAuthError, KleoraError, TokenError } from './errors.js'
import { postToken } from './http.js'
import { decodeJwt, userFromClaims, validateIdToken } from './jwt.js'
import { codeChallengeS256, createCodeVerifier, randomValue } from './pkce.js'
import {
  clearLikelySession,
  hasLikelySession as readLikelySession,
  markLikelySession,
} from './session-marker.js'
import { accountPortalUrl, assertTarget } from './portal.js'
import { createRefreshTokenStore, TransactionStore, type Transaction } from './storage.js'
import type {
  AccessTokenOptions,
  AuthState,
  CallbackResult,
  DiscoveryDocument,
  LoginOptions,
  LogoutOptions,
  KleoraClient,
  KleoraOptions,
  OpenAccountPortalOptions,
  TokenResponse,
  User,
} from './types.js'

/** The default scope of a browser client. */
export const DEFAULT_SCOPE = 'openid profile email offline_access'

/** Refresh once the access token is this close to `exp`. */
export const REFRESH_THRESHOLD_MS = 30_000

/**
 * The budget `checkSession()`'s hidden-iframe `prompt=none` attempt used to
 * have. Nothing reads it any more.
 *
 * @deprecated `checkSession()` no longer loads a hidden iframe (gh-1073), so
 * there is no budget to wait out. Exported only so an import of it keeps
 * compiling; it goes at the next major version.
 */
export const SILENT_TIMEOUT_MS = 10_000

/**
 * The query parameters an authorization response puts in the address bar.
 * They are stripped once read, so a credential does not sit in history, in a
 * `Referer`, or in whatever the user pastes into a bug report.
 */
const RESPONSE_PARAMS = ['code', 'state', 'iss', 'error', 'error_description'] as const

const NO_SESSION = 'there is no refresh token; call loginWithRedirect() first'
const REFRESH_REFUSED = 'the issuer refused the refresh token; the session is over'

/**
 * The RFC 6749 §5.2 errors that mean the credential itself is finished.
 *
 * `invalid_grant` means the token is unknown, expired,
 * revoked, already used, or its session has ended, and no retry will change
 * that. `invalid_client` and `invalid_scope` join it because they describe
 * the same permanence from the other two directions — the client this token
 * is bound to no longer authenticates, or the scope it was granted is no
 * longer grantable. Everything else the endpoint can answer (a 429, a 503, a
 * gateway's HTML, a body that will not parse) is a condition that may not
 * hold a second from now, and signing the user out over it would turn a blip
 * into a full re-authorisation.
 */
const TERMINAL_GRANT_ERRORS = new Set(['invalid_grant', 'invalid_client', 'invalid_scope'])

/** `returnTo` travels inside `appState`, which is what the Nuxt route reads. */
function mergeAppState(appState: unknown, returnTo: string | undefined): unknown {
  if (returnTo === undefined) return appState
  if (appState === undefined) return { returnTo }
  if (typeof appState === 'object' && appState !== null && !Array.isArray(appState)) {
    return { ...appState, returnTo }
  }
  return { appState, returnTo }
}

export function createKleora(options: KleoraOptions): KleoraClient {
  const issuer = parseAbsolute('issuer', options.issuer)
  // A trailing slash on a configured issuer is a typo, not a different
  // environment; normalising it here is what keeps the byte-for-byte
  // comparisons against `iss` further down from turning it into an
  // EnvironmentMismatch. `URL` re-adds a root slash, so the canonical form is
  // computed from `href` rather than from the caller's string.
  const issuerValue = issuer.href.replace(/\/+$/, '')

  const redirect = parseAbsolute('redirectUri', options.redirectUri)
  // The sandbox guard: a mismatch throws EnvironmentMismatch before any
  // network call.
  assertSameEnvironment('redirectUri', redirect, issuer)

  if (options.clientId.length === 0) {
    throw new KleoraError('invalid_configuration', 'clientId must not be empty')
  }

  const clientId = options.clientId
  const redirectUri = options.redirectUri
  const scope = options.scope ?? DEFAULT_SCOPE
  const audience = options.audience
  const defaultTenant = options.tenant
  const strategy = options.storage ?? 'memory'

  const discovery = createDiscovery(issuer, fetchRef)
  const transactions = new TransactionStore(clientId)
  const refreshTokens = createRefreshTokenStore(strategy, clientId)
  const listeners = new Set<(state: AuthState) => void>()

  let accessToken: string | null = null
  let accessTokenExpiresAt = 0
  let idToken: string | null = null
  let user: User | null = null
  let refreshInFlight: Promise<string> | null = null

  function snapshot(): AuthState {
    return { user, isAuthenticated: accessToken !== null }
  }

  function emit(): void {
    const state = snapshot()
    for (const listener of listeners) {
      try {
        listener(state)
      } catch {
        // One subscriber's exception is not the others' problem, and it is
        // certainly not a reason to abandon whatever the SDK was doing —
        // `logout()` in particular has a navigation to perform after this.
        // Nothing is logged (the SDK has no telemetry), and a rethrown error would
        // reach a caller who did not write the subscriber.
      }
    }
  }

  /**
   * Forget everything. Returns whether there was anything to forget, so the
   * caller can avoid announcing a transition that did not happen.
   */
  function clearAuth(): boolean {
    const held =
      accessToken !== null || idToken !== null || user !== null || refreshTokens.get() !== null
    accessToken = null
    accessTokenExpiresAt = 0
    idToken = null
    user = null
    refreshTokens.clear()
    // The session marker: a render hint, cleared alongside the tokens it was standing in
    // for — logout and every path that routes through `clearAuth()` are all
    // "there is definitely no session" moments.
    clearLikelySession(clientId)
    return held
  }

  /** Clear, and announce it only if the client was signed in a moment ago. */
  function signOut(): void {
    if (clearAuth()) emit()
  }

  function fresh(): boolean {
    return accessToken !== null && accessTokenExpiresAt - Date.now() > REFRESH_THRESHOLD_MS
  }

  /**
   * The access token is opaque to this package — verifying it is the resource
   * server's job — but its `env` and `aud` claims are readable, and they are
   * what catches a client pointed at the wrong environment.
   */
  function checkAccessToken(token: string): void {
    let claims: Record<string, unknown>
    try {
      claims = decodeJwt(token)
    } catch {
      // Not a JWT this package can read. That is between the caller and its
      // resource server; the SDK never inspects the token otherwise.
      return
    }
    assertTokenEnvironment(claims, issuer)

    if (audience !== undefined) {
      const value = claims['aud']
      const audiences = typeof value === 'string' ? [value] : value
      if (Array.isArray(audiences) && !audiences.includes(audience)) {
        throw new TokenError(
          'audience_mismatch',
          `the access token's aud does not contain the configured audience '${audience}'`,
        )
      }
    }
  }

  /**
   * Adopt a token response.
   *
   * `expectedNonce` is present only for the authorization-code grant: a
   * rotated token has no authorization request behind it, so its ID token
   * carries no `nonce` and demanding one would reject every refresh.
   */
  function adopt(response: TokenResponse, expectedNonce?: string): void {
    let nextIdToken = idToken
    let nextUser = user

    if (response.id_token !== undefined) {
      const claims = validateIdToken(response.id_token, {
        issuer: issuerValue,
        clientId,
        nonce: expectedNonce,
      })
      assertTokenEnvironment(claims, issuer)
      nextIdToken = response.id_token
      nextUser = userFromClaims(claims)
    }

    checkAccessToken(response.access_token)

    idToken = nextIdToken
    user = nextUser
    accessToken = response.access_token
    accessTokenExpiresAt = Date.now() + response.expires_in * 1000
    if (response.refresh_token !== undefined) {
      // Rotation: the new token replaces the old one, which the issuer has
      // already spent.
      refreshTokens.set(response.refresh_token)
    }
    // The session marker: every path through `adopt()` — a login callback or a refresh —
    // is a real, current session. Only reached once every
    // validation above has already succeeded.
    markLikelySession(clientId)
  }

  async function startAuthorization(
    document: DiscoveryDocument,
    login: LoginOptions,
  ): Promise<{ url: string; transaction: Transaction }> {
    const codeVerifier = createCodeVerifier()
    const transaction: Transaction = {
      state: randomValue(32),
      nonce: randomValue(32),
      codeVerifier,
      redirectUri,
      appState: mergeAppState(login.appState, login.returnTo),
      createdAt: Date.now(),
    }
    transactions.put(transaction)

    const url = new URL(document.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', scope)
    url.searchParams.set('state', transaction.state)
    url.searchParams.set('nonce', transaction.nonce)
    url.searchParams.set('code_challenge', await codeChallengeS256(codeVerifier))
    url.searchParams.set('code_challenge_method', 'S256')

    const tenant = login.tenant ?? defaultTenant
    if (tenant !== undefined) url.searchParams.set('tenant', tenant)
    if (login.prompt !== undefined) url.searchParams.set('prompt', login.prompt)
    if (login.loginHint !== undefined) url.searchParams.set('login_hint', login.loginHint)

    return { url: url.href, transaction }
  }

  /** Read the authorization response out of a URL and clean the URL. */
  function stripResponse(href: string): { params: URLSearchParams; cleaned: string } {
    const url = new URL(href)
    const params = new URLSearchParams(url.search)
    for (const name of RESPONSE_PARAMS) url.searchParams.delete(name)
    return { params, cleaned: url.pathname + url.search + url.hash }
  }

  /**
   * Redeem a code from the redirect callback: `state`, `iss` and the ID token
   * are all checked here.
   */
  async function redeem(
    document: DiscoveryDocument,
    params: URLSearchParams,
  ): Promise<Transaction> {
    const failure = params.get('error')
    const state = params.get('state')

    if (failure !== null) {
      if (state !== null) transactions.discard(state)
      // Status 0: this refusal arrived as redirect parameters rather than as
      // an HTTP response body, but it is the same RFC 6749 §5.2 vocabulary.
      throw new OAuthError(failure, params.get('error_description') ?? undefined, 0)
    }

    const code = params.get('code')
    if (code === null || state === null) {
      throw new KleoraError(
        'invalid_callback',
        'the callback URL carries neither an authorization code nor an error',
      )
    }

    // RFC 9207: the issuer names itself in the response, so a code obtained
    // from one authorization server cannot be replayed at another.
    const iss = params.get('iss')
    if (iss !== issuerValue) {
      transactions.discard(state)
      throw new TokenError(
        'issuer_mismatch',
        `the authorization response names issuer '${iss ?? '(absent)'}', expected '${issuerValue}'`,
      )
    }

    // Single use: `take` removes the row, so a replayed callback URL finds
    // nothing and is rejected as an unknown `state`.
    const transaction = transactions.take(state)
    if (transaction === null) {
      throw new KleoraError(
        'invalid_state',
        'the callback state does not match any authorization request started in this tab',
      )
    }

    const response = await postToken(fetchRef(), document.token_endpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: transaction.redirectUri,
      client_id: clientId,
      code_verifier: transaction.codeVerifier,
    })

    adopt(response, transaction.nonce)
    return transaction
  }

  async function refresh(): Promise<string> {
    const token = refreshTokens.get()
    if (token === null) {
      // Nothing to clear on a client that was never signed in, and nothing to
      // announce either — a spurious `{ isAuthenticated: false }` would tell
      // a subscriber a session ended when none ever began.
      signOut()
      throw new LoginRequired(NO_SESSION)
    }

    const document = await discovery()
    let response: TokenResponse
    try {
      response = await postToken(fetchRef(), document.token_endpoint, {
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: clientId,
      })
    } catch (error) {
      // Only a refusal that names the credential ends the session. A 429, a
      // 503, a gateway's HTML and a dead network all leave the stored refresh
      // token exactly as valid as it was, so they are rethrown untouched and
      // the next `getAccessToken()` tries again.
      if (error instanceof OAuthError && TERMINAL_GRANT_ERRORS.has(error.error)) {
        signOut()
        throw new LoginRequired(REFRESH_REFUSED)
      }
      throw error
    }

    try {
      adopt(response)
    } catch (error) {
      // The tokens came back but cannot be trusted (wrong environment, an ID
      // token that fails validation). Rotation has already spent the stored
      // token server-side, so there is nothing left to keep.
      signOut()
      throw error
    }
    emit()
    return response.access_token
  }

  function currentAccessToken(options: AccessTokenOptions = {}): Promise<string> {
    if (options.force !== true && fresh() && accessToken !== null) {
      return Promise.resolve(accessToken)
    }
    if (options.force === true) {
      // Drop it before the refresh, not after: a caller that forced this did
      // so because a resource server refused the cached token, and handing
      // that same token to a concurrent caller in the meantime would send the
      // rejected credential out again. `emit()` is deliberately not called —
      // nothing has changed for a subscriber until the refresh answers.
      accessToken = null
      accessTokenExpiresAt = 0
    }
    // One refresh at a time: a page that fires five requests at once must not
    // spend five refresh tokens, because with rotation four of them would be
    // reuse and would revoke the whole family.
    refreshInFlight ??= refresh().finally(() => {
      refreshInFlight = null
    })
    return refreshInFlight
  }

  let account: AccountClient | null = null

  function portalUrl(portal: OpenAccountPortalOptions = {}): string {
    return accountPortalUrl({
      issuer: issuerValue,
      clientId,
      ...(portal.section === undefined ? {} : { section: portal.section }),
      ...(portal.returnTo === undefined ? {} : { returnTo: portal.returnTo }),
    })
  }

  return {
    accountPortalUrl: portalUrl,

    openAccountPortal(portal: OpenAccountPortalOptions = {}): void {
      const target = portal.target ?? '_blank'
      assertTarget(target)
      // `noopener` on a new tab: the portal is another origin's page and has
      // no business holding a reference back into this one.
      openRef()(portalUrl(portal), target, target === '_blank' ? 'noopener' : '')
    },

    // Built on first use: most applications never call the self-service API,
    // and the ones that do share one client per `createKleora`.
    get account(): AccountClient {
      account ??= createAccountClient({ issuer: issuerValue, getAccessToken: currentAccessToken })
      return account
    },

    async loginWithRedirect(login: LoginOptions = {}): Promise<void> {
      const document = await discovery()
      const { url } = await startAuthorization(document, login)
      locationRef().assign(url)
    },

    async handleRedirectCallback(): Promise<CallbackResult> {
      const { params, cleaned } = stripResponse(locationRef().href)

      // Strip first, redeem second: from here on the code is out of the
      // address bar whatever happens next.
      historyRef()?.replaceState(null, '', cleaned)

      const document = await discovery()
      const transaction = await redeem(document, params)
      emit()
      return transaction.appState === undefined ? {} : { appState: transaction.appState }
    },

    getAccessToken: currentAccessToken,

    getUser(): User | null {
      return user
    },

    hasLikelySession(): boolean {
      return readLikelySession(clientId)
    },

    async checkSession(): Promise<AuthState | null> {
      if (fresh()) return snapshot()

      // No usable refresh token is a `null`, at once — never a hidden
      // `prompt=none` iframe (gh-1073). That iframe could not work: the
      // issuer answers every response with `X-Frame-Options: DENY` and
      // `frame-ancestors 'none'`, and an application
      // on another site would not get the `SameSite=Lax` session cookie into
      // it even if it could. All it ever did was spend its 10 s budget before
      // the caller's `loginWithRedirect()` — a top-level navigation, where
      // the cookie is first-party — did what it could not.
      //
      // The session marker is left alone on that `null`: "this tab holds no
      // refresh token" (a new tab under `session` storage, any reload under
      // `memory`) says nothing about the issuer's session, so it is not the
      // authoritative "no session" that clears the hint. A stale marker costs
      // one paint of the shell before the redirect, and cannot loop: the
      // redirect lands on the issuer's own page, and only a completed sign-in
      // brings the browser back.
      if (refreshTokens.get() === null) return null

      try {
        await currentAccessToken()
        return snapshot()
      } catch (error) {
        if (error instanceof EnvironmentMismatch) throw error
        // A refused refresh token has already been cleared, and the marker
        // with it (`refresh()` → `signOut()`); a 429, a 5xx or a dead network
        // leaves both as they were. Either way there is no session in hand.
        return null
      }
    },

    async logout(logoutOptions: LogoutOptions): Promise<void> {
      const hint = idToken

      // Local state first (clear storage, then navigate) and
      // before the discovery fetch, not after it: a discovery document that
      // never arrives must still leave this browser signed out.
      signOut()

      const document = await discovery()
      const url = new URL(document.end_session_endpoint)
      if (hint !== null) url.searchParams.set('id_token_hint', hint)
      // Required alongside `post_logout_redirect_uri` when there is no hint,
      // and harmless when there is (OpenID Connect RP-Initiated Logout).
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('post_logout_redirect_uri', logoutOptions.returnTo)
      locationRef().assign(url.href)
    },

    onAuthChange(callback: (state: AuthState) => void): () => void {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
  }
}
