/**
 * The non-sensitive "this browser had a session" marker.
 *
 * A reload with `storage: 'memory'` loses the refresh token — that is the
 * whole point of `memory` — and so does a new tab under `session`, so the app
 * has no way to tell "probably signed in, about to be signed straight back in
 * by the issuer" from "definitely signed out" until `checkSession()` answers
 * and, when it says `null`, the redirect comes back. Without
 * a hint, a consumer has one honest choice: render the signed-out state (a
 * flash, if the session turns out to be good) or render the signed-in state
 * (wrong, if it does not) until the answer arrives. Neither is right, so this
 * is a third thing: a hint that render code may use to choose "show the
 * shell and wait" over "show nothing and wait" — never an input to anything
 * that decides whether a request is authorised.
 *
 * **`localStorage`, deliberately, and only for this.** `storage.ts` explains
 * at length why a refresh token never goes there: it is origin-wide,
 * indefinite, and readable by any script the origin will ever run, so a
 * stolen token surviving there is a stolen session. None of that is a risk
 * here, because this value is not a credential. It grants nothing by itself
 * — a script that read it would learn only what a single failed `fetch`
 * against the API already tells it for free — and its worst-case misuse is a
 * render decision, not an authorisation one: a stale `true` produces a
 * loading shell that resolves to the login page a moment later, and a stale
 * `false` produces a slightly less optimistic first paint. Origin-wide
 * persistence is the point, not the risk, here: it is what lets a second tab
 * of an already-signed-in browser make the same good guess a reload in the
 * first tab does.
 *
 * Keyed by `clientId`, matching every other per-client key this package
 * writes (`storage.ts`'s transaction and refresh-token prefixes), so two
 * clients on one origin do not read each other's hint.
 */

import { localStore } from './browser.js'

const MARKER_PREFIX = 'kleora:had-session:'

function key(clientId: string): string {
  return `${MARKER_PREFIX}${clientId}`
}

/**
 * Whether this browser has previously completed a sign-in that was never
 * followed by a logout or an authoritative "no session" answer.
 *
 * A render hint only. `true` is not proof of a live session — only
 * `checkSession()` (or a successful API call) is that — and `false` is not
 * proof of the opposite either, just this package's best guess from what it
 * last observed in this browser.
 */
export function hasLikelySession(clientId: string, store: Storage | null = localStore()): boolean {
  if (store === null) return false
  try {
    return store.getItem(key(clientId)) === '1'
  } catch {
    return false
  }
}

/** Record a successful sign-in: a login callback or a refresh. */
export function markLikelySession(clientId: string, store: Storage | null = localStore()): void {
  if (store === null) return
  try {
    store.setItem(key(clientId), '1')
  } catch {
    // A full or blocked store costs this hint its memory across reloads; the
    // in-memory token still works for this page load regardless.
  }
}

/**
 * Retire the marker: on `logout()`, and on any restore the issuer
 * authoritatively refused — a refresh token answered `invalid_grant` and its
 * kin. A transient failure — a dropped connection, a 429,
 * a 5xx — leaves it exactly as it was, the same rule `client.ts`'s `refresh()`
 * applies to the refresh token itself: only a refusal that names the
 * credential ends the story early. So does a tab that simply holds no refresh
 * token: `checkSession()` answers `null` for it without asking the issuer
 * anything, which proves nothing about the issuer's session.
 */
export function clearLikelySession(clientId: string, store: Storage | null = localStore()): void {
  if (store === null) return
  try {
    store.removeItem(key(clientId))
  } catch {
    // As above.
  }
}
