// When to re-provision a proxy session (/network/auth-client) ahead of its
// expiry. Shared by the bridge's background renewal alarm (bridge/background.ts)
// and the popup's multi-IP pool (utils/connection-manager.ts).
//
// A fixed fraction of the lifetime renews every browser whose session started
// at the same moment (a fleet restart, recovery from an outage) at the same
// moment again, every lifetime. Instead each session renews at its own point
// between 70% and 80% of its lifetime, derived from a hash of the session's
// identity (its client id). The point is a pure function of the session, so
// recomputing it after a browser or service worker restart gives the same
// point, while every new session (a new client id) gets its own.
//
// Bounds:
// - never later than 80% of the lifetime, so a failed renewal keeps the last
//   fifth of the session for its retries;
// - never sooner than RENEW_MIN_DELAY_MS after provisioning, so a short
//   lifetime (or a local clock running ahead of the server's) cannot
//   re-provision in a tight loop. When even the 80% point is sooner than that
//   there is no proactive renewal: the session runs to its expiry, as it does
//   when the server sends no expiration time at all.

export const RENEW_FRACTION_MIN = 0.7;
export const RENEW_FRACTION_MAX = 0.8;
export const RENEW_MIN_DELAY_MS = 60_000;

/** The session's renewal point as a fraction of its lifetime, in [0.7, 0.8). */
export function renewFraction(sessionKey: string): number {
	return RENEW_FRACTION_MIN + (RENEW_FRACTION_MAX - RENEW_FRACTION_MIN) * unitHash(sessionKey);
}

/**
 * Milliseconds from provisioning until the session renews, or null for no
 * proactive renewal (no usable lifetime, or one too short to renew in
 * without looping). `lifetimeMs` is the time left until the session's
 * expiration, measured when it was provisioned.
 */
export function renewDelayMs(sessionKey: string, lifetimeMs: number): number | null {
	if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
		return null;
	}
	const latest = Math.floor(lifetimeMs * RENEW_FRACTION_MAX);
	if (latest < RENEW_MIN_DELAY_MS) {
		return null;
	}
	const point = Math.floor(lifetimeMs * renewFraction(sessionKey));
	return Math.min(latest, Math.max(RENEW_MIN_DELAY_MS, point));
}

// [0, 1) from 32-bit FNV-1a over the key's UTF-16 code units, finished with
// the murmur3 fmix32 avalanche so keys that differ in one character spread
// over the whole range. Not a security boundary: it only spreads load.
function unitHash(key: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	h ^= h >>> 16;
	h = Math.imul(h, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return (h >>> 0) / 0x1_0000_0000;
}
