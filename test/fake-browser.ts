/**
 * The smallest browser the SDK will run in.
 *
 * `src/browser.ts` reaches for `sessionStorage`, `location`, `history`,
 * `document` and `fetch` lazily and one at a time, which is exactly what
 * makes this possible: the tests install real-enough stand-ins on
 * `globalThis` and get the production code paths, without a DOM
 * implementation in the dependency tree.
 */

import { afterEach } from 'vitest'

export class FakeStorage implements Storage {
  private readonly entries = new Map<string, string>()

  get length(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  /** Everything currently stored, for assertions about what was written. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.entries)
  }
}

export interface FakeLocation {
  href: string
  assign(url: string): void
  /** Every URL `assign` was called with, in order. */
  readonly navigations: string[]
}

export interface FakeBrowser {
  session: FakeStorage
  local: FakeStorage
  location: FakeLocation
  /** Every URL passed to `history.replaceState`. */
  replaced: string[]
}

interface Saved {
  key: string
  descriptor: PropertyDescriptor | undefined
}

const saved: Saved[] = []

/**
 * Swap a global, remembering its property *descriptor* rather than its value.
 *
 * Node defines `localStorage` as a lazy accessor that prints an experimental
 * warning the first time it is read, and a helper that saved values by
 * reading them would print it on every test run.
 */
function install(key: string, value: unknown): void {
  saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) })
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  })
}

/** Restore `globalThis` after every test so suites cannot leak into each other. */
afterEach(() => {
  while (saved.length > 0) {
    const entry = saved.pop()
    if (entry === undefined) break
    if (entry.descriptor === undefined) {
      delete (globalThis as unknown as Record<string, unknown>)[entry.key]
    } else {
      Object.defineProperty(globalThis, entry.key, entry.descriptor)
    }
  }
})

export function installFakeBrowser(href = 'https://app.example.com/'): FakeBrowser {
  const session = new FakeStorage()
  const local = new FakeStorage()
  const navigations: string[] = []
  const replaced: string[] = []

  const location: FakeLocation = {
    href,
    navigations,
    assign(url: string) {
      navigations.push(url)
      location.href = url
    },
  }

  install('sessionStorage', session)
  install('localStorage', local)
  install('location', location)
  install('history', {
    replaceState(_state: unknown, _title: string, url: string) {
      replaced.push(url)
      location.href = new URL(url, location.href).href
    },
  })

  return { session, local, location, replaced }
}

/** Replace `fetch` with a handler and return the requests it saw. */
export function installFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  install('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  })
  return { calls }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** The body of a request `installFetch` recorded, parsed as a form. */
export function formOf(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
}

/** Replace `window.open` and return the calls it saw (`openAccountPortal`). */
export function installOpen(): { calls: [string, string, string][] } {
  const calls: [string, string, string][] = []
  install('open', (url: string, target: string, features: string) => {
    calls.push([url, target, features])
    return null
  })
  return { calls }
}
