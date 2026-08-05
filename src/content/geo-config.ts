// Geolocation override — ISOLATED world companion.
//
// The MAIN-world patch (geo-main.ts) has no `chrome.*`, so it cannot read the
// user's opt-in or the provider coordinates itself. This script runs in the
// same frames at document_start with extension privileges, reads
// chrome.storage.local, and hands the result over the shared DOM.
//
// Why storage and not messaging: chrome.storage.local is readable from a
// content script on both Chromium and Firefox without the background service
// being awake, and chrome.storage.onChanged delivers live updates to every
// frame for free — so the override keeps working with the popup closed and
// after an MV3 service-worker restart. (chrome.storage.session would need
// setAccessLevel("TRUSTED_AND_UNTRUSTED_CONTEXTS"), which is not available on
// every Firefox we support.)
//
// It stays *silent* on pages where the feature has never been on: dispatching
// an "urnetwork" event on every page in the world would hand every site a new
// fingerprint for users who never enabled anything. When silent, geo-main.ts
// times out and restores the native methods.
import {
	GEO_CONFIG_EVENT,
	GEO_POSITION_MAX_AGE_MS,
	GEO_REQUEST_EVENT,
	STORAGE_KEY_GEO_ENABLED,
	STORAGE_KEY_GEO_POSITION,
	type GeoConfigFrame,
	type GeoOverrideConfig,
	type GeoSyncPosition,
} from "./geo-protocol";

// Pinned by the MAIN patch on first sight so a page cannot switch the override
// off mid-visit with a forged event.
const token =
	typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID()
		: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

let last: GeoOverrideConfig | null = null;

function send(config: GeoOverrideConfig): void {
	last = config;
	const frame: GeoConfigFrame = { token, config };
	try {
		// a string detail: object details do not cross the world boundary on
		// Firefox without cloneInto()
		document.dispatchEvent(
			new CustomEvent(GEO_CONFIG_EVENT, { detail: JSON.stringify(frame) }),
		);
	} catch {
		// document gone
	}
}

function toConfig(enabled: boolean, raw: unknown): GeoOverrideConfig {
	if (!enabled || !raw || typeof raw !== "object") return { active: false };
	const position = raw as Partial<GeoSyncPosition>;
	const lat = Number(position.lat);
	const lon = Number(position.lon);
	const accuracy = Number(position.accuracy);
	const updatedAt = Number(position.updatedAt);
	if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { active: false };
	if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { active: false };
	if (!Number.isFinite(accuracy) || accuracy <= 0) return { active: false };
	// a position nobody has refreshed in hours is not where traffic exits any more
	if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > GEO_POSITION_MAX_AGE_MS) {
		return { active: false };
	}
	return { active: true, lat, lon, accuracy };
}

function read(): void {
	let result: Promise<Record<string, unknown>>;
	try {
		// Promise.resolve so a browser that only honours the callback form does
		// not throw here — the read simply yields nothing and geo-main.ts falls
		// back to the native methods.
		result = Promise.resolve(
			chrome.storage.local.get([STORAGE_KEY_GEO_ENABLED, STORAGE_KEY_GEO_POSITION]),
		);
	} catch {
		// extension context invalidated (update/uninstall)
		return;
	}
	result
		.then((raw) => {
			const stored = raw ?? {};
			const enabled = stored[STORAGE_KEY_GEO_ENABLED] === true;
			// stay quiet on pages that never had the feature on — see the note above
			if (!enabled && last === null) return;
			send(toConfig(enabled, stored[STORAGE_KEY_GEO_POSITION]));
		})
		.catch(() => {
			// storage unavailable — geo-main.ts falls back to the native methods
		});
}

// The MAIN patch asks on startup in case this script got there first.
document.addEventListener(GEO_REQUEST_EVENT, () => {
	if (last !== null) send(last);
});

try {
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (!changes[STORAGE_KEY_GEO_ENABLED] && !changes[STORAGE_KEY_GEO_POSITION]) return;
		read();
	});
} catch {
	// no storage listener — the config is still read once below
}

read();
