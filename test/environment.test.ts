/** The sandbox guard. */

import { describe, expect, it } from 'vitest'

import {
  assertSameEnvironment,
  assertTokenEnvironment,
  classify,
  parseAbsolute,
} from '../src/environment.js'
import { EnvironmentMismatch, KleoraError } from '../src/errors.js'

const PRODUCTION = new URL('https://acme.kleora.eu')
const SANDBOX = new URL('https://acme-sandbox.kleora.eu')

/**
 * The classification table, one rule for every SDK.
 *
 * **The same hosts and the same verdicts appear in the test suites of
 * `@kleora-io/node` and of `kleora` (Python).** Three
 * implementations that agree only by coincidence is the defect this table
 * exists to prevent, so a row added here belongs in the other two as well.
 */
const CLASSIFICATION: ReadonlyArray<readonly [string, string, string]> = [
  ['acme.kleora.eu', 'production', 'a production issuer'],
  ['acme-sandbox.kleora.eu', 'sandbox', 'a sandbox issuer'],
  // The shape sandbox issuers used to have. Minted nowhere now,
  // and no edge serves it: reading it as sandbox would only widen the guard.
  ['acme.sandbox.kleora.eu', 'production', 'the retired two-label shape'],
  // A Kleora under a base domain carrying the suffix mints this *production*
  // issuer; the rule reads the first label only, so the base never reaches it.
  ['acme.corp-sandbox.internal', 'production', 'a base domain that carries the suffix'],
  // A base domain carrying the label: a substring test for
  // `.sandbox.` reads it as sandbox and would pair a `kl_test_` key with it.
  ['acme.corp.sandbox.internal', 'production', 'a base domain that carries the label'],
  ['my-sandbox-app.kleora.eu', 'production', 'the word inside a slug, not at its end'],
  ['my-sandbox-app-sandbox.kleora.eu', 'sandbox', 'that slug’s sandbox side'],
  // `sandbox` is a reserved App slug, and the suffix needs a slug before it.
  ['sandbox.kleora.eu', 'production', 'the bare word'],
  ['-sandbox.kleora.eu', 'production', 'the suffix with nothing before it'],
  ['id-sandbox.localhost:8100', 'sandbox', 'development, with a port'],
  ['id.localhost:8100', 'production', 'development, with a port'],
  ['ACME-SANDBOX.kleora.eu', 'sandbox', 'DNS labels are case-insensitive'],
  ['app.example.com', 'production', 'a customer host announces nothing'],
  ['app-sandbox.example.com', 'sandbox', 'a customer host that does announce it'],
  ['localhost', 'production', 'a single label that is not a sandbox'],
]

describe('classify', () => {
  it.each(CLASSIFICATION)('reads %s as %s (%s)', (host, kind) => {
    expect(classify(host)).toBe(kind)
  })
})

describe('parseAbsolute', () => {
  it.each(['', 'not-a-url', '/relative', 'ftp://example.com'])('refuses %s', (value) => {
    expect(() => parseAbsolute('issuer', value)).toThrow(KleoraError)
  })

  it('accepts http, because sandbox issuers are reachable over it locally', () => {
    expect(parseAbsolute('issuer', 'http://id.localhost:8100').host).toBe('id.localhost:8100')
  })
})

describe('assertSameEnvironment', () => {
  it('refuses a sandbox redirect URI on a production issuer', () => {
    expect(() =>
      assertSameEnvironment('redirectUri', new URL('https://x-sandbox.example/cb'), PRODUCTION),
    ).toThrow(EnvironmentMismatch)
  })

  it('leaves a customer’s own redirect URI alone', () => {
    // `https://app.example.com/callback` says nothing about which environment
    // it belongs to; classifying it would refuse every real configuration.
    expect(() =>
      assertSameEnvironment('redirectUri', new URL('https://app.example.com/callback'), SANDBOX),
    ).not.toThrow()
    expect(() =>
      assertSameEnvironment('redirectUri', new URL('http://localhost:5173/cb'), SANDBOX),
    ).not.toThrow()
  })

  it('accepts an endpoint on the issuer’s own host', () => {
    expect(() =>
      assertSameEnvironment('token_endpoint', new URL(`${SANDBOX.origin}/oauth/token`), SANDBOX),
    ).not.toThrow()
  })
})

describe('assertTokenEnvironment', () => {
  it('refuses a production token from a sandbox issuer', () => {
    expect(() => {
      assertTokenEnvironment({ env: 'production' }, SANDBOX)
    }).toThrow(EnvironmentMismatch)
  })

  it('accepts a token whose env matches', () => {
    expect(() => {
      assertTokenEnvironment({ env: 'sandbox' }, SANDBOX)
    }).not.toThrow()
    expect(() => {
      assertTokenEnvironment({ env: 'production' }, PRODUCTION)
    }).not.toThrow()
  })

  it('says nothing about a token with no env claim', () => {
    expect(() => {
      assertTokenEnvironment({ sub: 'x' }, SANDBOX)
    }).not.toThrow()
  })
})
