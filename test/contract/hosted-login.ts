/**
 * A cookie jar and enough of the flow API to walk a sign-in.
 *
 * The contract suite needs a real authorization code, and the only way to get
 * one is the way a person gets one: `/oauth/authorize` → the hosted pages →
 * whatever tenant resolution decides → back to `redirect_uri`. Playwright would
 * be the other option, but this package must not grow a browser download to
 * run `pnpm test`.
 *
 * The hosted pages are a static SPA and there is no form to
 * scrape: the browser lands on a route, reads `req` off its own URL, and calls
 * `/flow/*` with JSON. This helper is that browser, minus the rendering — which
 * makes it *simpler* than the HTML-scraping version it replaces, and closer to
 * what a real one does. The flow API's same-origin rule
 * is satisfied the way a
 * browser satisfies it: every mutating request carries
 * `Content-Type: application/json` and an `Origin` equal to the issuer's own.
 */

const MAX_HOPS = 20

/** The SPA routes this helper knows how to be. */
const LOGIN = '/login'
const SELECT_TENANT = '/select-tenant'

/** A cookie jar scoped to one issuer, which is all this suite talks to. */
class Jar {
  private readonly cookies = new Map<string, string>()

  absorb(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';')
      const separator = pair?.indexOf('=') ?? -1
      if (pair === undefined || separator <= 0) continue
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (value === '' || header.includes('Max-Age=0')) {
        this.cookies.delete(name)
      } else {
        this.cookies.set(name, value)
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

export interface Credentials {
  email: string
  password: string
}

export class HostedLoginError extends Error {}

interface Envelope {
  step: string
  redirect_to?: string
  tenants?: { id: string; name: string; slug: string }[]
  code?: string
}

/**
 * Walk the hosted pages from `authorizeUrl` until the browser is sent to
 * `redirectUri`, and return that URL with its query string.
 */
export async function driveHostedLogin(
  authorizeUrl: string,
  redirectUri: string,
  credentials: Credentials,
): Promise<URL> {
  const jar = new Jar()
  const target = new URL(redirectUri)
  let current = authorizeUrl

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const url = new URL(current)
    if (url.origin === target.origin && url.pathname === target.pathname) {
      return url
    }

    // A navigation: `/oauth/authorize`, the continuation, or a `redirect_to`
    // the flow API named. Followed by hand so the jar sees every `Set-Cookie`.
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: jar.header() === '' ? {} : { Cookie: jar.header() },
    })
    jar.absorb(response)

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location')
      if (location === null) throw new HostedLoginError(`${url.href} redirected without a Location`)
      current = new URL(location, url).href
      continue
    }
    if (response.status !== 200) {
      throw new HostedLoginError(`${url.href} answered ${String(response.status)}`)
    }

    // The bundle answered, so the browser is standing on an SPA route. Read
    // `req` off the URL and act as that route acts.
    await response.arrayBuffer()
    current = await act(url, jar, credentials)
  }

  throw new HostedLoginError(`the hosted login did not reach ${redirectUri} in ${MAX_HOPS} hops`)
}

/** What the route at `url` does, and where it sends the browser next. */
async function act(url: URL, jar: Jar, credentials: Credentials): Promise<string> {
  const req = url.searchParams.get('req')
  if (req === null) {
    throw new HostedLoginError(`${url.pathname} carries no req for this helper to continue`)
  }

  if (url.pathname.endsWith(LOGIN)) {
    const envelope = await call(url.origin, 'POST', '/flow/login', jar, {
      req,
      email: credentials.email,
      password: credentials.password,
    })
    return navigation(url, envelope)
  }

  if (url.pathname.endsWith(SELECT_TENANT)) {
    const listed = await call(url.origin, 'GET', `/flow/tenants?req=${encodeURIComponent(req)}`, jar)
    const tenant = listed.tenants?.[0]
    if (tenant === undefined) {
      throw new HostedLoginError('the tenant step offered no workspace to select')
    }
    const envelope = await call(url.origin, 'POST', '/flow/select-tenant', jar, {
      req,
      tenant: tenant.id,
    })
    return navigation(url, envelope)
  }

  throw new HostedLoginError(`unexpected hosted route: ${url.pathname}`)
}

/** One flow call, shaped the way the SPA's `fetch` shapes one. */
async function call(
  origin: string,
  method: 'GET' | 'POST',
  path: string,
  jar: Jar,
  payload?: Record<string, string>,
): Promise<Envelope> {
  const response = await fetch(new URL(path, origin), {
    method,
    redirect: 'manual',
    headers: {
      ...(jar.header() === '' ? {} : { Cookie: jar.header() }),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  jar.absorb(response)

  const body = (await response.json()) as Envelope
  if (response.status !== 200) {
    throw new HostedLoginError(`${method} ${path} answered ${String(response.status)}: ${body.code}`)
  }
  return body
}

/** The absolute URL a `redirect` envelope names. */
function navigation(url: URL, envelope: Envelope): string {
  if (envelope.redirect_to === undefined) {
    throw new HostedLoginError(`the flow answered "${envelope.step}" with nowhere to go`)
  }
  return new URL(envelope.redirect_to, url).href
}
