/**
 * The sandbox guard.
 *
 * An environment is classified from its host alone: the host's **first** DNS
 * label ends in `-sandbox`, or it is production. Every URL the client is asked to
 * call has to agree with the issuer's classification, so a copy-pasted sandbox
 * `redirectUri` cannot end up receiving production codes and a discovery
 * document from the wrong environment cannot be adopted.
 */

import { EnvironmentMismatch, KleoraError } from './errors.js'

export type EnvironmentKind = 'sandbox' | 'production'

/** A sandbox issuer's first label is its App's slug plus this. */
const SANDBOX_SUFFIX = '-sandbox'

/**
 * A `:port` on the end of a host. `URL.host` carries one and `URL.hostname`
 * does not, and both reach `classify`; stripping it here — as
 * `kleora._environments` does — is what makes `id-sandbox.localhost`
 * and `id-sandbox.localhost:8100` the same question.
 */
const PORT_SUFFIX = /:\d+$/

const notAbsolute = (name: string, value: string): string =>
  `${name} must be an absolute http(s) URL, got '${value}'`

/** Parse and refuse anything that is not an absolute `http`/`https` URL. */
export function parseAbsolute(name: string, value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new KleoraError('invalid_configuration', notAbsolute(name, value))
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new KleoraError('invalid_configuration', notAbsolute(name, value))
  }
  return url
}

/**
 * `sandbox` when the host's first DNS label ends in `-sandbox`, `production`
 * otherwise. Case-insensitive, and any `:port` is ignored.
 *
 * **The one rule, for every SDK.** `@kleora-io/node` and `kleora` (Python)
 * implement this same test, and all three carry the same table of boundary
 * cases in their tests.
 *
 * It is the inverse of how the platform mints an issuer: `{slug}.{base}` for
 * production and `{slug}-sandbox.{base}` for sandbox, an App slug is a
 * *single* DNS label, and no slug may end in `-sandbox` — so the first label
 * ends in `-sandbox` if and only if the environment is, for any base domain,
 * scheme or port.
 *
 * Sandbox issuers used to be `{slug}.sandbox.{base}`; that shape is minted
 * nowhere any more. A substring test for `.sandbox.` would misread a base
 * domain carrying the label — `corp.sandbox.internal`, say, whose
 * *production* issuer is `acme.corp.sandbox.internal` — as sandbox. Anchoring the test to the
 * one label the platform controls is what keeps the guard from relaxing: a
 * base domain never reaches the first label, so `acme.corp-sandbox.internal`
 * is production here.
 */
export function classify(host: string): EnvironmentKind {
  const first = host.toLowerCase().replace(PORT_SUFFIX, '').split('.')[0] ?? ''
  return first.length > SANDBOX_SUFFIX.length && first.endsWith(SANDBOX_SUFFIX)
    ? 'sandbox'
    : 'production'
}

/**
 * Whether a host is one of ours, and so subject to the guard.
 *
 * A customer's own `redirectUri` (`https://app.example.com/callback`,
 * `http://localhost:5173/cb`) is not a Kleora host and says nothing about
 * which environment it belongs to; classifying it would refuse every
 * legitimate configuration. What the guard is actually for is the host that
 * *does* announce itself — one whose first label ends in `-sandbox` — and the issuer
 * host itself.
 */
function isKleoraHost(host: string, issuerHost: string): boolean {
  return host === issuerHost || classify(host) === 'sandbox'
}

/**
 * Refuse `url` when it belongs to the other environment.
 *
 * Called for the `redirectUri` at construction (before any network call, as
 * the guard promises) and for every endpoint the discovery document names.
 */
export function assertSameEnvironment(name: string, url: URL, issuer: URL): void {
  if (!isKleoraHost(url.host, issuer.host)) {
    return
  }
  const kind = classify(url.host)
  const issuerKind = classify(issuer.host)
  if (kind !== issuerKind) {
    throw new EnvironmentMismatch(
      `${name} '${url.href}' is a ${kind} URL but the issuer '${issuer.href}' is ` +
        `${issuerKind}; sandbox and production must not be mixed`,
    )
  }
}

/**
 * Refuse a token whose `env` claim names the other environment.
 *
 * The claim is read, not verified — the browser never checks a signature
 * (ruling 2) — so this catches a misconfiguration, not an attacker. An
 * attacker who could mint the token could mint the claim too; the backend's
 * signature check is what stands between them and an accepted token.
 */
export function assertTokenEnvironment(claims: Record<string, unknown>, issuer: URL): void {
  const env = claims['env']
  if (typeof env !== 'string') {
    return
  }
  const issuerKind = classify(issuer.host)
  if (env !== issuerKind) {
    throw new EnvironmentMismatch(
      `the token's env claim is '${env}' but the issuer '${issuer.href}' is ${issuerKind}`,
    )
  }
}
