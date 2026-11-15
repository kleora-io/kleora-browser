/**
 * `@kleora-io/browser` — the authorization-code + PKCE client for
 * single-page applications.
 *
 * ```ts
 * import { createKleora } from '@kleora-io/browser'
 * const kleora = createKleora({ issuer, clientId, redirectUri })
 * ```
 */

export { createKleora, DEFAULT_SCOPE, REFRESH_THRESHOLD_MS, SILENT_TIMEOUT_MS } from './client.js'
export {
  createAccountClient,
  type AccountClient,
  type AccountClientOptions,
  type AccountComponents,
  type AccountDeletion,
  type AccountEmail,
  type AccountEmailSent,
  type AccountIdentities,
  type AccountIdentity,
  type AccountMfa,
  type AccountMfaFactor,
  type AccountPasskey,
  type AccountPasskeys,
  type AccountPasswordPolicy,
  type AccountPortal,
  type AccountProblem,
  type AccountProfile,
  type AccountProfileChanges,
  type AccountReauthentication,
  type AccountRecoveryCodes,
  type AccountSession,
  type AccountSessionPage,
  type AccountSessionsRevoked,
  type AccountSetting,
  type AccountSettings,
  type AccountSettingValue,
  type AccountTotpEnrollment,
  type ChangePasswordOptions,
  type ListSessionsOptions,
} from './account.js'
export {
  ACCOUNT_PORTAL_SECTIONS,
  accountPortalUrl,
  type AccountPortalOptions,
  type AccountPortalSection,
  type AccountPortalTarget,
  type AccountPortalUrlOptions,
} from './portal.js'
export {
  ApiError,
  EnvironmentMismatch,
  LoginRequired,
  OAuthError,
  KleoraError,
  TokenError,
  type TokenErrorCode,
} from './errors.js'
export { classify, type EnvironmentKind } from './environment.js'
export { CLOCK_LEEWAY_SECONDS } from './jwt.js'
export type {
  AccessTokenOptions,
  AuthState,
  CallbackResult,
  DiscoveryDocument,
  LoginOptions,
  LogoutOptions,
  KleoraClient,
  OpenAccountPortalOptions,
  KleoraOptions,
  StorageStrategy,
  TokenResponse,
  User,
} from './types.js'
