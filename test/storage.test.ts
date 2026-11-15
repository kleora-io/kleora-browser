/** Where the two persisted values live, and where they do not (ruling 2). */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createRefreshTokenStore, TransactionStore } from '../src/storage.js'
import { installFakeBrowser, type FakeBrowser } from './fake-browser.js'

const CLIENT_ID = 'kleora-console'

let browser: FakeBrowser

beforeEach(() => {
  browser = installFakeBrowser()
})

function transaction(state: string, createdAt = Date.now()) {
  return {
    state,
    nonce: 'n',
    codeVerifier: 'v',
    redirectUri: 'https://app.example.com/auth/callback',
    createdAt,
  }
}

describe('TransactionStore', () => {
  it('keys the pending request by state so two logins do not collide', () => {
    const store = new TransactionStore(CLIENT_ID)
    store.put(transaction('one'))
    store.put(transaction('two'))

    expect(store.take('one')?.state).toBe('one')
    expect(store.take('two')?.state).toBe('two')
  })

  it('spends a state once — a replayed callback finds nothing', () => {
    const store = new TransactionStore(CLIENT_ID)
    store.put(transaction('one'))

    expect(store.take('one')).not.toBeNull()
    expect(store.take('one')).toBeNull()
    expect(browser.session.snapshot()).toEqual({})
  })

  it('returns null for a state it never issued', () => {
    expect(new TransactionStore(CLIENT_ID).take('forged')).toBeNull()
  })

  it('sweeps a transaction older than the AuthRequest lifetime', () => {
    // The issuer forgets an authorization request after 10 minutes, so an
    // older transaction can never be completed.
    const store = new TransactionStore(CLIENT_ID)
    store.put(transaction('stale', Date.now() - 11 * 60 * 1000))
    store.put(transaction('fresh'))

    expect(store.take('stale')).toBeNull()
    expect(store.take('fresh')).not.toBeNull()
  })

  it('writes only to sessionStorage', () => {
    new TransactionStore(CLIENT_ID).put(transaction('one'))

    expect(Object.keys(browser.session.snapshot())).toHaveLength(1)
    expect(browser.local.snapshot()).toEqual({})
  })

  it('survives a sessionStorage that throws on every call', () => {
    // Safari in private browsing, and any embedding that blocks storage.
    const hostile = {
      get length(): number {
        throw new Error('denied')
      },
      clear: vi.fn(() => {
        throw new Error('denied')
      }),
      getItem: () => {
        throw new Error('denied')
      },
      key: () => {
        throw new Error('denied')
      },
      removeItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: hostile,
      configurable: true,
      writable: true,
    })

    const store = new TransactionStore(CLIENT_ID)

    expect(() => {
      store.put(transaction('one'))
    }).not.toThrow()
    expect(store.take('one')).toBeNull()
  })
})

describe('createRefreshTokenStore', () => {
  it('keeps a memory-strategy token out of every store', () => {
    const store = createRefreshTokenStore('memory', CLIENT_ID)
    store.set('rt-1')

    expect(store.get()).toBe('rt-1')
    expect(browser.session.snapshot()).toEqual({})
    expect(browser.local.snapshot()).toEqual({})
  })

  it('mirrors a session-strategy token into sessionStorage and never localStorage', () => {
    const store = createRefreshTokenStore('session', CLIENT_ID)
    store.set('rt-1')

    expect(Object.values(browser.session.snapshot())).toEqual(['rt-1'])
    expect(browser.local.snapshot()).toEqual({})
  })

  it('reads a token a previous page load left in sessionStorage', () => {
    createRefreshTokenStore('session', CLIENT_ID).set('rt-1')

    // A reload: a brand-new client over the same tab-scoped storage.
    expect(createRefreshTokenStore('session', CLIENT_ID).get()).toBe('rt-1')
  })

  it('does not read a memory-strategy token back after a reload', () => {
    createRefreshTokenStore('session', CLIENT_ID).set('rt-1')

    expect(createRefreshTokenStore('memory', CLIENT_ID).get()).toBeNull()
  })

  it('clears both copies', () => {
    const store = createRefreshTokenStore('session', CLIENT_ID)
    store.set('rt-1')
    store.clear()

    expect(store.get()).toBeNull()
    expect(browser.session.snapshot()).toEqual({})
  })

  it('replaces rather than accumulates on rotation', () => {
    const store = createRefreshTokenStore('session', CLIENT_ID)
    store.set('rt-1')
    store.set('rt-2')

    expect(Object.values(browser.session.snapshot())).toEqual(['rt-2'])
  })
})
