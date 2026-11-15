/**
 * The two things that outlive a function call: the pending authorization
 * request and the refresh token.
 *
 * Neither ever touches `localStorage`. See the README for why; the short
 * version is that `localStorage` is origin-wide and permanent, so a refresh
 * token there is readable by every tab and every script that will ever be
 * injected into the origin, for as long as the browser profile lives. This
 * rule is about credentials, not about `localStorage` itself — `session-
 * marker.ts` keeps a non-sensitive render hint there, deliberately, and
 * explains why that is a different question with a different answer.
 */

import { sessionStore } from './browser.js'

/** Everything `handleRedirectCallback()` needs, keyed by `state`. */
export interface Transaction {
  state: string
  nonce: string
  codeVerifier: string
  redirectUri: string
  appState?: unknown
  createdAt: number
}

/**
 * The issuer forgets an authorization request after 10 minutes, so a
 * transaction older than that can never be completed and is swept on the
 * next write.
 */
const TRANSACTION_TTL_MS = 10 * 60 * 1000

const TRANSACTION_PREFIX = 'kleora:tx:'
const REFRESH_PREFIX = 'kleora:rt:'

function read(store: Storage | null, key: string): string | null {
  if (store === null) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

function write(store: Storage | null, key: string, value: string): void {
  if (store === null) return
  try {
    store.setItem(key, value)
  } catch {
    // A full or blocked store is not fatal for the refresh token (the
    // in-memory copy still works for this page) and the callback will simply
    // report an unknown `state`, which is the safe direction to fail.
  }
}

function remove(store: Storage | null, key: string): void {
  if (store === null) return
  try {
    store.removeItem(key)
  } catch {
    // As above.
  }
}

/**
 * The pending-authorization store.
 *
 * `sessionStorage` rather than a cookie or memory: the values have to survive
 * a full-page navigation to the issuer and back, must not
 * leave the tab, and must not be sent anywhere. Keyed by `state` so two
 * logins started in the same tab cannot overwrite each other.
 */
export class TransactionStore {
  private readonly prefix: string

  constructor(clientId: string) {
    this.prefix = `${TRANSACTION_PREFIX}${clientId}:`
  }

  put(transaction: Transaction): void {
    const store = sessionStore()
    this.purge(store, transaction.createdAt)
    write(store, this.prefix + transaction.state, JSON.stringify(transaction))
  }

  /**
   * Read and delete in one step — a `state` is single-use, so a replayed
   * callback URL finds nothing: the verifier is removed from
   * `sessionStorage` after use.
   */
  take(state: string): Transaction | null {
    const store = sessionStore()
    const key = this.prefix + state
    const raw = read(store, key)
    remove(store, key)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as Transaction
    } catch {
      return null
    }
  }

  /** Drop a transaction that will never be completed. */
  discard(state: string): void {
    remove(sessionStore(), this.prefix + state)
  }

  private purge(store: Storage | null, now: number): void {
    if (store === null) return
    try {
      const stale: string[] = []
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index)
        if (key === null || !key.startsWith(this.prefix)) continue
        const raw = store.getItem(key)
        if (raw === null) continue
        let createdAt = 0
        try {
          createdAt = (JSON.parse(raw) as Transaction).createdAt
        } catch {
          createdAt = 0
        }
        if (now - createdAt > TRANSACTION_TTL_MS) stale.push(key)
      }
      for (const key of stale) store.removeItem(key)
    } catch {
      // A store that refuses enumeration simply keeps its entries; they are
      // tab-scoped and expire with the tab anyway.
    }
  }
}

/** Where the refresh token lives for the lifetime of the client. */
export interface RefreshTokenStore {
  get(): string | null
  set(token: string): void
  clear(): void
}

/**
 * `memory` keeps the token in a closure and nothing else; `session` mirrors
 * it into `sessionStorage` so a reload inside the same tab can refresh
 * without a round trip through the issuer.
 */
export function createRefreshTokenStore(
  strategy: 'memory' | 'session',
  clientId: string,
): RefreshTokenStore {
  let held: string | null = null
  if (strategy === 'memory') {
    return {
      get: () => held,
      set: (token) => {
        held = token
      },
      clear: () => {
        held = null
      },
    }
  }

  const key = `${REFRESH_PREFIX}${clientId}`
  return {
    get: () => held ?? read(sessionStore(), key),
    set: (token) => {
      held = token
      write(sessionStore(), key, token)
    },
    clear: () => {
      held = null
      remove(sessionStore(), key)
    },
  }
}
