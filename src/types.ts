/** The public surface of `@kleora-io/browser`. */

import type { AccountClient } from './account.js'
import type { AccountPortalOptions, AccountPortalTarget } from './portal.js'

/**
 * Where the refresh token lives.
 *
 * `memory` keeps it in a closure, so a reload has none and goes through
 * `loginWithRedirect()` again.
 * `session` additionally persists it in `sessionStorage`, which is tab-scoped
 * and cleared when the tab closes. `localStorage` is deliberately not an
 * option — see the README.
 */
export type StorageStrategy = 'memory' | 'session'

export interface KleoraOptions {
  /** The environment's issuer, e.g. `https://acme.kleora.eu`. */
  issuer: string
  /** The Client's `client_id`. Must be a `spa` client. */
  clientId: string
  /** One of the Client's registered `redirect_uris`, matched exactly. */
  redirectUri: string
  /** Default `openid profile email offline_access`. */
  scope?: string
  /** The environment's `api_audience`, when it declares one. */
  audience?: string
  /** Pin every login to one tenant (slug). */
  tenant?: string
  /** Default `memory`. */
  storage?: StorageStrategy
}

export interface LoginOptions {
  /** Carried through the redirect and returned as `appState.returnTo`. */
  returnTo?: string
  /** `none` re-authorises silently; `login` forces credentials again. */
  prompt?: 'none' | 'login' | 'select_account'
  /** Overrides the client-wide `tenant` for this request. */
  tenant?: string
  /** Pre-fills the email field on the hosted login page. */
  loginHint?: string
  /** Anything JSON-serialisable; handed back by `handleRedirectCallback()`. */
  appState?: unknown
}

/** The ID-token claims `getUser()` exposes. */
export interface User {
  sub: string
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  tenant?: string
  tenant_slug?: string
}

/** What every `onAuthChange` subscriber receives. */
export interface AuthState {
  user: User | null
  isAuthenticated: boolean
}

export interface AccessTokenOptions {
  /**
   * Discard the cached access token and refresh, even when it is nowhere near
   * expiry.
   *
   * For the one case the cache cannot see: a resource server that answered
   * 401 for a token this client still believes in — revoked, or issued before
   * a change the server has since made. Without it a caller can only re-send
   * the same rejected token, which is how a "refresh and retry" turns into an
   * unbounded sign-in loop.
   */
  force?: boolean
}

export interface CallbackResult {
  /** The `appState` passed to `loginWithRedirect()`, if any. */
  appState?: unknown
}

export interface LogoutOptions {
  /**
   * Where the issuer sends the browser once the session is gone. Must be one
   * of the Client's `post_logout_redirect_uris`, matched exactly.
   */
  returnTo: string
}

export interface KleoraClient {
  /**
   * Mints `state`, `nonce` and a PKCE verifier, stores them in
   * `sessionStorage` keyed by `state`, and navigates to the authorization
   * endpoint. The returned promise does not resolve before the navigation.
   */
  loginWithRedirect(options?: LoginOptions): Promise<void>
  /**
   * Completes the redirect: validates `state` and `iss`, redeems the code,
   * validates the ID token, stores the tokens and strips the credentials out
   * of the address bar.
   */
  handleRedirectCallback(): Promise<CallbackResult>
  /**
   * A valid access token, refreshing when within 30 s of expiry — or
   * immediately under `{ force: true }`. Concurrent callers share one
   * refresh either way.
   */
  getAccessToken(options?: AccessTokenOptions): Promise<string>
  /** The current ID-token claims, or `null` when signed out. */
  getUser(): User | null
  /**
   * Whether this browser carries a marker from a previous successful
   * sign-in — a *render hint only*: never an authorisation input, never
   * trusted by anything that gates data. `true` is not proof of a live
   * session (only `checkSession()`, or a successful API call, is that); it
   * is what lets a consumer show "probably signed in, verifying" instead of
   * "definitely signed out" before `checkSession()` answers. Cleared by
   * `logout()` and by a refresh token the issuer refused; a tab with no
   * refresh token, a 429, a 5xx or a network failure leaves it as it was.
   */
  hasLikelySession(): boolean
  /**
   * Restores a session from a still-fresh access token or the stored refresh
   * token, or resolves `null` at once — never by loading the issuer in a
   * frame. On `null`, `loginWithRedirect()` is the way back in.
   */
  checkSession(): Promise<AuthState | null>
  /** Clears local state, then navigates to the end-session endpoint. */
  logout(options: LogoutOptions): Promise<void>
  /** Subscribe to login, logout and refresh. Returns an unsubscribe. */
  onAuthChange(callback: (state: AuthState) => void): () => void
  /**
   * The hosted account portal's URL for this client's issuer and Client
   * (`{issuer}/account[/{section}]`). A pure function.
   *
   * **The portal is offered only when this Client lists `self_service` in
   * `allowed_scopes`**; for any other Client every portal page says it is not
   * offered. `returnTo` becomes the portal's "back" link only when it equals
   * one of the Client's `post_logout_redirect_uris`.
   */
  accountPortalUrl(options?: AccountPortalOptions): string
  /**
   * Open the account portal — in a new tab (`'_blank'`, with `noopener`) by
   * default, or in this window. There is no frame option: the portal refuses
   * to be framed. The same `self_service` requirement applies.
   */
  openAccountPortal(options?: OpenAccountPortalOptions): void
  /**
   * The end-user self-service API, called with this client's own access
   * token. Needs `self_service` in the Client's `allowed_scopes` **and** in
   * this client's `scope`, which the default scope does not include.
   */
  readonly account: AccountClient
}

export interface OpenAccountPortalOptions extends AccountPortalOptions {
  /** Default `'_blank'`. */
  target?: AccountPortalTarget
}

/** The subset of the discovery document this package uses. */
export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  revocation_endpoint: string
  end_session_endpoint: string
}

/** A successful `POST /oauth/token` body (RFC 6749 §5.1). */
export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
  id_token?: string
  refresh_token?: string
}
