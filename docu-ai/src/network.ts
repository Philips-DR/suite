import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

/**
 * Give each connection attempt long enough to succeed on a slow network.
 *
 * Node races IPv6 against IPv4 when a host has both ("happy eyeballs"), but allows each attempt
 * only 250ms by default. On a network where IPv6 has no route and IPv4 takes ~500ms to connect,
 * every attempt times out and `fetch` fails with ETIMEDOUT — which googleapis reports as a bare
 * "request to https://oauth2.googleapis.com/token failed, reason: ", indistinguishable from a
 * dead token. Found live (2026-09-26): builds that had worked an hour earlier failed on every
 * call while `curl` reached Google fine, because curl waits longer. `node:https` with family 4
 * connected in ~500ms; `fetch` with this timeout raised connected at once.
 *
 * Process-wide state, so only a front door calls it, once, at startup — never library code.
 */
export function tolerateSlowConnections(): void {
  setDefaultAutoSelectFamilyAttemptTimeout(2000)
}
