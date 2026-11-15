/**
 * The error hierarchy shared by the Kleora SDKs.
 *
 * Every failure the SDK raises is a `KleoraError` with a machine-readable
 * `code`, so an application can branch on the code without matching on
 * English prose. Messages are English and written for developers.
 */

/** Base class for everything this package throws. */
export class KleoraError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KleoraError'
    this.code = code
  }
}

/**
 * Codes for a token that cannot be trusted.
 *
 * The first six are shared with `@kleora-io/node`. The
 * browser never verifies a signature — that is the backend's job on
 * redemption (`invalid_signature` and `unknown_kid` therefore never arise
 * here) — but it does check the `nonce` it minted, which no backend verifier
 * ever sees, so `nonce_mismatch` is this package's addition.
 */
export type TokenErrorCode =
  | 'expired'
  | 'invalid_signature'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'unknown_kid'
  | 'malformed'
  | 'nonce_mismatch'

/** A token failed validation. */
export class TokenError extends KleoraError {
  declare readonly code: TokenErrorCode

  constructor(code: TokenErrorCode, message: string) {
    super(code, message)
    this.name = 'TokenError'
  }
}

/**
 * There is no usable session; the application must call
 * `loginWithRedirect()`.
 */
export class LoginRequired extends KleoraError {
  constructor(message: string) {
    super('login_required', message)
    this.name = 'LoginRequired'
  }
}

/**
 * A sandbox issuer was mixed with production configuration or the reverse
 * Thrown before any credential is sent.
 */
export class EnvironmentMismatch extends KleoraError {
  constructor(message: string) {
    super('environment_mismatch', message)
    this.name = 'EnvironmentMismatch'
  }
}

/**
 * An RFC 6749 §5.2 refusal from `/oauth/token`.
 *
 * `ApiError` is for RFC 9457 problem documents; the OAuth endpoints answer in a different shape and
 * need a type of their own that keeps `error` addressable.
 */
export class OAuthError extends KleoraError {
  readonly error: string
  readonly errorDescription: string | undefined
  readonly status: number

  constructor(error: string, description: string | undefined, status: number) {
    super(error, description ? `${error}: ${description}` : error)
    this.name = 'OAuthError'
    this.error = error
    this.errorDescription = description
    this.status = status
  }
}

/** The RFC 9457 problem document shape the management API answers with. */
export class ApiError extends KleoraError {
  readonly type: string
  readonly status: number
  readonly detail: string | undefined
  readonly errors: unknown[] | undefined

  constructor(
    type: string,
    status: number,
    detail: string | undefined,
    errors: unknown[] | undefined,
  ) {
    super('api_error', detail ?? type)
    this.name = 'ApiError'
    this.type = type
    this.status = status
    this.detail = detail
    this.errors = errors
  }
}
