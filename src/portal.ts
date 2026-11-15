/**
 * The hosted account portal's URL.
 *
 * ```
 * {issuer}/account[/{section}]?client_id={client_id}&return_to={url}
 * ```
 *
 * **The portal is offered only for a Client whose `allowed_scopes` include
 * `self_service`** (that list is the consent, because there is no consent
 * screen). For any other Client this URL still
 * opens, and every portal page says "Managing your account here is not offered
 * for {app}" instead of its content. Nothing here can tell the two apart: the
 * URL is a pure function of its inputs, and whether the named Client offers the
 * portal is the issuer's to decide when the page loads.
 *
 * It opens in a new tab or a top-level navigation and **never in a frame**:
 * every issuer document refuses to be framed (`frame-ancestors 'none'`), so
 * there is no frame option here to choose.
 */

import { parseAbsolute } from './environment.js'
import { KleoraError } from './errors.js'

/**
 * The portal's sections, in the order the portal lists them
 * (the `PortalSection` enum of the account API's OpenAPI document,
 * `openapi/account-v1.json`); `test/portal.test.ts` holds the two equal.
 *
 * `danger` exists only where the Environment offers self-deletion; linking to
 * it elsewhere lands on the portal's own not-found page, which is the issuer's
 * answer rather than one this package can know in advance.
 */
export const ACCOUNT_PORTAL_SECTIONS = [
  'profile',
  'password',
  'security',
  'sessions',
  'danger',
] as const

export type AccountPortalSection = (typeof ACCOUNT_PORTAL_SECTIONS)[number]

/** The portal URL's own inputs, once the issuer and Client are known. */
export interface AccountPortalOptions {
  /** A section to open at; the portal home when absent. */
  section?: AccountPortalSection
  /**
   * Where the portal's "back to the application" link points. Must be an
   * absolute `http`/`https` URL with no fragment and no userinfo, or
   * `KleoraError('invalid_configuration')`. The issuer honours it only when it
   * equals one of the Client's `post_logout_redirect_uris` exactly, and
   * otherwise renders no return link at all — that membership is the issuer's
   * to check, and this package cannot know the list.
   */
  returnTo?: string
}

/** `accountPortalUrl`'s input: the portal URL's inputs, plus whose portal. */
export interface AccountPortalUrlOptions extends AccountPortalOptions {
  /** The Environment's issuer, e.g. `https://acme.kleora.eu`. */
  issuer: string
  /**
   * The Client the portal is opened for. Its `allowed_scopes` decide whether
   * the portal is offered, and its `post_logout_redirect_uris` whether
   * `returnTo` becomes a link.
   */
  clientId: string
}

const invalid = (message: string): KleoraError => new KleoraError('invalid_configuration', message)

/**
 * Refuse a `returnTo` of the wrong *shape*.
 *
 * The issuer's own three rules for a registered URI: absolute `http`/`https`,
 * no fragment, no userinfo. A value breaking one of them can never equal a
 * registered `post_logout_redirect_uris` entry, so the issuer would silently
 * drop the link; saying so here, at the call, is the difference between a
 * developer's error and a missing link nobody notices.
 */
export function assertReturnTo(value: string): void {
  const url = parseAbsolute('returnTo', value)
  if (url.hash !== '' || value.includes('#')) {
    throw invalid(`returnTo must not carry a fragment, got '${value}'`)
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid(`returnTo must not carry userinfo, got '${value}'`)
  }
}

function assertSection(section: string): void {
  if (!(ACCOUNT_PORTAL_SECTIONS as readonly string[]).includes(section)) {
    throw invalid(
      `section must be one of ${ACCOUNT_PORTAL_SECTIONS.join(', ')}; got '${section}'`,
    )
  }
}

/**
 * The account portal's URL — a pure function, no request.
 *
 * Works only for a Client that lists `self_service` in `allowed_scopes`; for
 * any other the portal renders its "not offered" sentence (see the module
 * comment).
 */
export function accountPortalUrl(options: AccountPortalUrlOptions): string {
  const issuer = parseAbsolute('issuer', options.issuer)
  if (options.clientId.length === 0) {
    throw invalid('clientId must not be empty')
  }
  if (options.section !== undefined) assertSection(options.section)
  if (options.returnTo !== undefined) assertReturnTo(options.returnTo)

  // The issuer's own path is kept (none is minted with one, but a trailing
  // slash is a typo, not a different place) and the portal's appended to it.
  const base = issuer.href.replace(/\/+$/, '')
  const path = options.section === undefined ? '/account' : `/account/${options.section}`
  const url = new URL(base + path)
  url.searchParams.set('client_id', options.clientId)
  if (options.returnTo !== undefined) url.searchParams.set('return_to', options.returnTo)
  return url.href
}

/** Where `openAccountPortal` may put the portal: a tab or this window, never a frame. */
export type AccountPortalTarget = '_blank' | '_self' | '_top'

const TARGETS: readonly string[] = ['_blank', '_self', '_top']

/**
 * Refuse a `target` that could name a frame.
 *
 * `window.open(url, name)` loads into an `<iframe name=…>` when one exists, so
 * an arbitrary string is a frame option in disguise. The portal refuses to be
 * framed anyway; refusing here says why instead of leaving a blank frame.
 */
export function assertTarget(target: string): asserts target is AccountPortalTarget {
  if (!TARGETS.includes(target)) {
    throw invalid(
      `target must be '_blank', '_self' or '_top'; the account portal is never framed ` +
        `(it refuses to be framed), got '${target}'`,
    )
  }
}
