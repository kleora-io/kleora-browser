/**
 * The non-sensitive "had a session" render marker. Where it lives,
 * that it never travels through `sessionStorage`, and its lifecycle: set on
 * a successful sign-in, cleared on logout and on an authoritative refusal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { clearLikelySession, hasLikelySession, markLikelySession } from '../src/session-marker.js'
import { installFakeBrowser, type FakeBrowser } from './fake-browser.js'

const CLIENT_ID = 'kleora-console'
const OTHER_CLIENT_ID = 'sample-app'

let browser: FakeBrowser

beforeEach(() => {
  browser = installFakeBrowser()
})

describe('hasLikelySession', () => {
  it('is false before anything has ever marked it', () => {
    expect(hasLikelySession(CLIENT_ID)).toBe(false)
  })

  it('is true once marked, for that client only', () => {
    markLikelySession(CLIENT_ID)

    expect(hasLikelySession(CLIENT_ID)).toBe(true)
    expect(hasLikelySession(OTHER_CLIENT_ID)).toBe(false)
  })

  it('writes only to localStorage, never sessionStorage', () => {
    markLikelySession(CLIENT_ID)

    expect(browser.session.snapshot()).toEqual({})
    expect(Object.keys(browser.local.snapshot())).toHaveLength(1)
  })

  it('survives a reload — a brand-new client over the same origin storage', () => {
    markLikelySession(CLIENT_ID)

    // A reload destroys the closure `memory` storage lives in but not
    // `localStorage`, which is the entire point of putting the marker there.
    expect(hasLikelySession(CLIENT_ID)).toBe(true)
  })
})

describe('clearLikelySession', () => {
  it('retires a marker set by a previous sign-in', () => {
    markLikelySession(CLIENT_ID)
    clearLikelySession(CLIENT_ID)

    expect(hasLikelySession(CLIENT_ID)).toBe(false)
  })

  it('leaves a sibling client untouched', () => {
    markLikelySession(CLIENT_ID)
    markLikelySession(OTHER_CLIENT_ID)
    clearLikelySession(CLIENT_ID)

    expect(hasLikelySession(CLIENT_ID)).toBe(false)
    expect(hasLikelySession(OTHER_CLIENT_ID)).toBe(true)
  })

  it('is idempotent — clearing an unset marker is not an error', () => {
    expect(() => clearLikelySession(CLIENT_ID)).not.toThrow()
    expect(hasLikelySession(CLIENT_ID)).toBe(false)
  })
})

describe('a storage that is absent or hostile', () => {
  it('reads as false rather than throwing when localStorage is missing', () => {
    expect(hasLikelySession(CLIENT_ID, null)).toBe(false)
  })

  it('never throws when localStorage refuses every call', () => {
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

    expect(() => markLikelySession(CLIENT_ID, hostile)).not.toThrow()
    expect(() => hasLikelySession(CLIENT_ID, hostile)).not.toThrow()
    expect(() => clearLikelySession(CLIENT_ID, hostile)).not.toThrow()
    expect(hasLikelySession(CLIENT_ID, hostile)).toBe(false)
  })
})
