// Shared contract for the geolocation override ("sync device location with
// oldest provider" on the web).
//
// Three surfaces read this file:
//   • geo-main.ts    — the MAIN-world patch (runs in the page's realm)
//   • geo-config.ts  — the ISOLATED-world companion that feeds it
//   • utils/geo-sync.ts — the background/popup side that writes the state
//
// It must therefore stay free of `chrome.*` and of any DOM/React import: the
// MAIN-world bundle is self-contained and runs under the *page's* CSP.

/**
 * chrome.storage.local key holding the user's opt-in (absent or false = off).
 * The override is off by default and is never enabled implicitly.
 */
export const STORAGE_KEY_GEO_ENABLED = "geo_sync_enabled";

/**
 * chrome.storage.local key holding the position to report (a GeoSyncPosition,
 * stored as an object). Written only while the toggle is on; cleared on
 * disconnect and when the toggle goes off.
 */
export const STORAGE_KEY_GEO_POSITION = "geo_sync_position";

/**
 * DOM events used to hand the config from the ISOLATED world to MAIN. MAIN has
 * no `chrome.*` access, so this is the only channel available at
 * document_start. `detail` is always a JSON *string*: object details do not
 * survive the world boundary on Firefox without cloneInto().
 *
 * The page shares the DOM and can therefore observe — and forge — these
 * events. See geo-main.ts (token pinning) for what that costs.
 */
export const GEO_CONFIG_EVENT = "urnetwork:geo-config";
export const GEO_REQUEST_EVENT = "urnetwork:geo-config-request";

/**
 * A stored position older than this is ignored. Positions are refreshed by the
 * app whenever the connected providers change, so a stale one means nothing
 * has reported in for hours (browser restarted while connected, app tab closed
 * mid-session) and the reported city may no longer be where traffic exits.
 */
export const GEO_POSITION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Accuracy radius reported for a city / region centroid, in meters. These are
 * honest: the coordinate is the centroid of the provider's city or region, not
 * a fix, and a browser's own network-based fix reports comparable radii.
 */
export const GEO_CITY_ACCURACY_M = 5_000;
export const GEO_REGION_ACCURACY_M = 50_000;

/** The position the override reports, as persisted in chrome.storage.local. */
export type GeoSyncPosition = {
	lat: number;
	lon: number;
	/** accuracy radius in meters (see GEO_*_ACCURACY_M) */
	accuracy: number;
	/** which centroid the coordinate came from */
	precision: "city" | "region";
	/** human label for the popup only — never exposed to pages */
	label: string;
	/** egress client id of the provider this came from, when known */
	clientId?: string;
	/** Date.now() when this was written */
	updatedAt: number;
};

/** What the MAIN-world patch is told. Deliberately minimal: no labels, no ids. */
export type GeoOverrideConfig =
	| { active: false }
	| { active: true; lat: number; lon: number; accuracy: number };

/** Frame carried by GEO_CONFIG_EVENT.detail (JSON-encoded). */
export type GeoConfigFrame = {
	/** per-realm token, pinned by the MAIN patch on first sight */
	token: string;
	config: GeoOverrideConfig;
};
