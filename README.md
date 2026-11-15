# `@kleora-io/browser`

The authorization-code + PKCE client for single-page applications. Zero
runtime dependencies, ESM only, evergreen browsers.

This README is the whole reference for the package: every option, every method
and every error code it can raise is below. Kleora's documentation, including
how to create an App and register a Client, is at https://kleora.io/en/docs.

## Install

```bash
npm install @kleora-io/browser
```

Requires a bundler and an evergreen browser. Node 22 or newer for the tooling.

## Quickstart

```ts
import { createKleora } from '@kleora-io/browser'
const kleora = createKleora({ issuer: '<issuer>', clientId: '<client_id>', redirectUri: location.origin + '/callback' })
if (location.pathname === '/callback') await kleora.handleRedirectCallback()
else if (!(await kleora.checkSession())) await kleora.loginWithRedirect()
const token = await kleora.getAccessToken()
```

`redirectUri` must be one of the Client's registered `redirect_uris`, matched
exactly — a trailing slash or an extra query string is a different URI as far
as the authorization endpoint is concerned.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `issuer` | — | The environment's issuer, e.g. `https://acme.kleora.eu`. A trailing slash is tolerated and normalised away. |
| `clientId` | — | The Client's `client_id`. Must be a `spa` client: PKCE is mandatory for those and this package always sends it. |
| `redirectUri` | — | Where the issuer sends the browser back. |
| `scope` | `openid profile email offline_access` | Drop `offline_access` and no refresh token is issued, so `getAccessToken()` cannot renew silently. |
| `audience` | — | The environment's `api_audience`, when it declares one. Checked against the access token's `aud`. |
| `tenant` | — | Pins every login to one tenant slug; `loginWithRedirect({ tenant })` overrides it per call. |
| `storage` | `memory` | `memory` or `session` — see below. |

## API

| Method | Behaviour |
| --- | --- |
| `loginWithRedirect({ returnTo?, prompt?, tenant?, loginHint?, appState? })` | Mints `state`, `nonce` and a PKCE verifier, stores them in `sessionStorage` keyed by `state`, and navigates to the authorization endpoint. `returnTo` is merged into `appState`. |
| `handleRedirectCallback()` | Validates `state` and `iss`, redeems the code, validates the ID token, stores the tokens, strips the credentials out of the address bar, and returns `{ appState }`. |
| `getAccessToken({ force? })` | The cached token while it is more than 30 s from expiry, otherwise a refresh. `force` discards the cached token and refreshes anyway — for the one case the cache cannot see, a resource server that answered 401 for a token this client still believes in. Concurrent callers share one refresh either way. |
| `getUser()` | `{ sub, email, email_verified, name, picture, tenant, tenant_slug }`, or `null`. |
| `hasLikelySession()` | Whether this browser carries a marker from a previous sign-in — a **render hint only**, never an authorisation input and never trusted by anything that gates data. See below. |
| `checkSession()` | Recovers a session on page load from a still-fresh access token or the stored refresh token (`session` storage), and resolves the auth state — or `null` **at once** when there is neither, so the caller's `loginWithRedirect()` can run straight away. It never loads the issuer in a hidden iframe: the issuer refuses to be framed, so that could only ever time out. When the person is still signed in at the issuer, the redirect comes straight back with a code and no prompt. |
| `logout({ returnTo })` | Clears local state, then navigates to the end-session endpoint. `returnTo` must be one of the Client's `post_logout_redirect_uris`. |
| `onAuthChange(cb)` | `cb({ user, isAuthenticated })` on login, logout and refresh. Returns an unsubscribe. |

## The account portal and the self-service API

**Both work only for a Client that lists `self_service` in its
`allowed_scopes`** — that list is the consent, because there is no consent
screen. For any other Client the portal opens and says that managing
the account there is not offered, and `/oauth/authorize` refuses a request for
the scope with `invalid_scope`.

| Member | Behaviour |
| --- | --- |
| `kleora.accountPortalUrl({ section?, returnTo? })` | The hosted account portal's URL for this client's issuer and Client: `{issuer}/account[/{section}]?client_id=…&return_to=…`. A pure function. `section` is one of `profile`, `password`, `security`, `sessions`, `danger`. `returnTo` must be an absolute `http`/`https` URL with no fragment and no userinfo (`KleoraError('invalid_configuration')` otherwise); the portal shows it as its "back" link only when it equals one of the Client's `post_logout_redirect_uris`, and ignores it otherwise. |
| `kleora.openAccountPortal({ section?, returnTo?, target? })` | Opens that URL — a new tab with `noopener` by default, or `'_self'`/`'_top'`. **There is no frame option**: the portal refuses to be framed, and a named `target` is refused because it could name an `<iframe>`. |
| `kleora.account` | The end-user self-service API (`/account/v1/*`), typed, called with this client's own access token: `getProfile()`, `updateProfile()`, `changePassword()`, `reauthenticate()`, `listSessions()`, `revokeOtherSessions()`, `startTotpEnrollment()`, `requestDeletion()` and the rest — one method per operation, named for what it does. Needs `self_service` in the `scope` you pass to `createKleora` as well as in the Client's `allowed_scopes`: the default scope does not ask for it. |
| `accountPortalUrl({ issuer, clientId, section?, returnTo? })`, `createAccountClient({ issuer, getAccessToken })` | The same two, without a `createKleora` client. |

```ts
const kleora = createKleora({ issuer, clientId, redirectUri, scope: 'openid profile email offline_access self_service' })
await kleora.account.reauthenticate(password)          // sensitive operations need this within 5 minutes
await kleora.account.changePassword({ currentPassword: password, newPassword })
kleora.openAccountPortal({ section: 'security', returnTo: location.origin + '/' })  // passkeys, linked accounts
```

Registering a passkey and linking a provider identity cannot be done from your
origin — a browser rule, not ours — so the API lists and removes them and the
portal's security page adds them. The shapes come from `src/generated/account.ts`,
generated from the deployed OpenAPI document
(https://id.kleora.eu/account/v1/openapi.json).

## Storage: why never `localStorage`

`memory` (the default) keeps both tokens in a closure. Nothing survives a
reload, so a page load's `checkSession()` resolves `null` and the page goes
through `loginWithRedirect()` — which the hosted session cookie answers with a
code and no prompt, because a top-level navigation carries it.

`session` additionally mirrors the refresh token into `sessionStorage`. That
store is scoped to the tab and cleared when the tab closes, so the exposure
window is bounded by the tab's lifetime — the trade is one fewer round trip
through the issuer on every reload within that tab.

`localStorage` is not offered, and adding it is not a configuration request
we can honour. It persists indefinitely, it is shared across every tab on the
origin, and it is readable by every script that will ever run there —
including one injected tomorrow into a dependency you shipped today. A
refresh token sitting in it survives until rotation happens to catch the
reuse, which may be never if the thief refreshes first. The access token is
never persisted anywhere under either strategy.

This is a rule about credentials, not about `localStorage` as such —
`hasLikelySession()` below keeps a non-sensitive render hint there,
deliberately, for a different reason.

## What is validated, and what is not

The ID token is checked for `iss` (exact string match), `aud` (must contain
the `clientId`), `nonce` (the one this client minted, for a code grant), `exp`
and `iat` (60 s of clock skew allowed in either direction).

**Signatures are not verified here.** The token arrived over TLS from the
token endpoint, in direct response to a code this client holds the PKCE
verifier for; an attacker who could substitute the body has already broken
the channel a JWKS fetch would travel over. Signature verification is the
resource server's job, where tokens arrive from untrusted callers — that is
what `@kleora-io/node` and `kleora` are for. Never treat a claim
read by this package as an authorisation decision on your API.

## `hasLikelySession()`: a render hint, not a credential

`memory` storage (the default) means a reload has nothing to show until
`checkSession()` answers and, when it says `null`, the round trip through the
issuer comes back — and so does a new tab under `session`, whose
`sessionStorage` starts empty. Without any
signal, a page has one honest choice — render "signed out" (a flash, if the
session turns out to be good) or render "signed in" (wrong, if it does not)
until the answer arrives. `hasLikelySession()` is a third option: it tells a
consumer whether this browser has completed a sign-in that has not since been
followed by a logout or an authoritative "no session" answer, so a page can
render its shell with loading placeholders — "probably signed in, verifying"
— instead of guessing.

It is `true` after a login callback or a refresh; `false` before either,
after `logout()`, and after a refresh the issuer rejected (`invalid_grant`,
`invalid_client`, `invalid_scope`). A `checkSession()` that resolves `null`
because the tab simply holds no refresh token leaves it unchanged — that says
nothing about the issuer's session — and so does a refresh that fails
ambiguously (a 429, a 5xx, a dead network): only a refusal that names the
credential ends the story, not a condition that may not hold a second from
now. A stale `true` costs one paint of the shell before the redirect to the
issuer, never a loop: the redirect lands on the issuer's own page, and only a
completed sign-in comes back.

**`true` is never proof of a live session.** It is this package's best guess
from what it last observed in this browser, and the only way to know for
certain is `checkSession()` or a successful API call. Never use it to decide
whether to render data, only whether to render a shell while data is still
arriving.

**It lives in `localStorage`, on purpose — the one exception to "why never
`localStorage`" above, because it is not a credential.** It grants nothing by
itself: a script that read it would learn only what one failed `fetch` already
tells it for free, and its worst-case misuse is an optimistic loading shell,
not a stolen session. Being origin-wide rather than tab-scoped is the point:
it is what lets a second tab of an already-signed-in browser make the same
good guess a reload in the first tab does.

## Sandbox guard

The issuer host is classified at construction: a host whose first label ends
in `-sandbox` (`acme-sandbox.kleora.eu`) is a sandbox, anything else is
production. A `redirectUri` on a Kleora host
of the other classification throws `EnvironmentMismatch` **before any network
call**. So does a discovery document whose `issuer` is not the configured
one, an endpoint the document names that is not on the issuer's origin, and a
token whose `env` claim disagrees.

## Errors

Every error is a `KleoraError` with a machine-readable `code`.

| Class | When |
| --- | --- |
| `TokenError` | An ID token failed validation. `code`: `expired`, `issuer_mismatch`, `audience_mismatch`, `nonce_mismatch`, `malformed`. |
| `LoginRequired` | There is no usable session — no refresh token, or the issuer refused the one held. Call `loginWithRedirect()`. |
| `EnvironmentMismatch` | Sandbox and production configuration were mixed. |
| `OAuthError` | An RFC 6749 §5.2 refusal, carrying `error` and `errorDescription`. `status` is `0` when it arrived as redirect parameters rather than as an HTTP response. |
| `ApiError` | An RFC 9457 problem document (a rate limit, for instance), carrying `type`, `status`, `detail`, `errors`. |
| `KleoraError` | Everything else, including `invalid_state`, `invalid_callback`, `network_error`, `invalid_configuration` and the `discovery_*` codes. |

A refresh clears local state, emits
`onAuthChange({ user: null, isAuthenticated: false })` and throws
`LoginRequired` only when the issuer names the credential itself —
`invalid_grant`, `invalid_client` or `invalid_scope`. Every other failure
(a 429, a 503, a gateway's HTML, a `fetch` that never completed) leaves the
stored refresh token exactly as valid as it was and is rethrown unchanged, so
the next `getAccessToken()` tries again. Signing a working session out over a
rate limit or a dropped packet would be the worse failure.

## Development

```bash
pnpm install
pnpm test        # unit suite
pnpm lint
pnpm typecheck
pnpm build
```

### The generated account client

`src/generated/account.ts` and its source, `openapi/account-v1.json`, are
written by `pnpm generate:client` from the OpenAPI document Kleora serves,
https://id.kleora.eu/account/v1/openapi.json (`ACCOUNT_OPENAPI_URL` overrides
it). Never edit either by hand. CI regenerates both and fails when they differ
from what is committed, so a change to the deployed API shows up as a red check:
run `pnpm generate:client`, adjust `src/account.ts` if an operation moved, and
commit the result.

### Contract tests

The contract suite in `test/contract/` runs against a live Kleora environment.
**It does not run in CI**: it needs a running environment, a test user and, for
the account suite, a management API base, none of which this repository holds.
It skips when `KLEORA_TEST_ISSUER` and `KLEORA_TEST_CLIENT_ID` are absent, so
`pnpm test` stays green without one. The full login round trip additionally
needs `KLEORA_TEST_USERNAME` and `KLEORA_TEST_PASSWORD`; the account suite also
needs `KLEORA_TEST_API_BASE`:

```bash
KLEORA_TEST_ISSUER=https://<your-app>-sandbox.<issuer-domain> \
KLEORA_TEST_CLIENT_ID=<client id> \
KLEORA_TEST_REDIRECT_URI=<a registered redirect URI> \
KLEORA_TEST_USERNAME=<a test user's email> \
KLEORA_TEST_PASSWORD=<their password> \
pnpm test
```

### Releasing

Bump `version` in `package.json` on `main`, then run the **Release** workflow
(`.github/workflows/release.yml`) by hand. It builds and publishes to npm by
trusted publishing, with provenance; no token is stored anywhere.

## Licence

[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0) —
the full, unmodified text ships inside this package, so it travels with
whatever you install. Apache-2.0 rather than a shorter permissive licence
because of the explicit patent grant in §3, which is the term a legal review of
a vendor SDK asks about.

**There is no `NOTICE` file**, here or in any other Kleora package, and that
is deliberate. Apache-2.0 §4(d) turns a `NOTICE` into an obligation that
propagates: every downstream redistributor of a work that has one must
reproduce its contents. Kleora is the sole copyright holder of the code in
these packages, so there is nothing to attribute, and a `NOTICE` would place a
requirement on you in exchange for nothing. Third-party dependencies keep their
own licences and their own notices; this package redistributes none of them —
its manifest names them and your installer fetches them.

Apache-2.0 covers what you install and compile into your own product: the
browser, Node, Nuxt and Python SDKs. It does **not** cover the rest of
Kleora — the hosted service, the API servers, the management console and the
hosted authentication pages are proprietary.
