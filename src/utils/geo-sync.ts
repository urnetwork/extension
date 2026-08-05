// Geolocation override — control plane.
//
// Holds the two pieces of state the override runs on, both in
// chrome.storage.local so that content scripts can read them directly (see
// content/geo-config.ts) and the popup and background stay in sync for free:
//
//   geo_sync_enabled  — the user's opt-in, off by default
//   geo_sync_position — the coordinates to report, derived from the oldest
//                       connected provider that has any
//
// Where the coordinates come from: the ur.io app tab holds the live
// DeviceRemote and pushes `getConnectedProviderLocations()` over the app
// bridge (verb SET_PROVIDER_LOCATIONS, see bridge/background.ts). The
// extension itself has no device plane.
import {
	GEO_CITY_ACCURACY_M,
	GEO_POSITION_MAX_AGE_MS,
	GEO_REGION_ACCURACY_M,
	STORAGE_KEY_GEO_ENABLED,
	STORAGE_KEY_GEO_POSITION,
	type GeoSyncPosition,
} from "../content/geo-protocol";

/** An unchanged position is only re-stamped once it is this old — see
 * storeProviderLocations. */
const REFRESH_STAMP_AFTER_MS = GEO_POSITION_MAX_AGE_MS / 4;

/**
 * The fields consumed from the sdk's `ConnectedProviderLocationInfo`
 * (sdk/js/src/types.ts). Declared structurally: the extension depends on
 * @urnetwork/sdk-js for REST hooks only and the published build predates this
 * type.
 */
export type ProviderLocationInfo = {
	clientId?: string;
	country?: string;
	countryCode?: string;
	region?: string;
	city?: string;
	regionLat?: number;
	regionLon?: number;
	cityLat?: number;
	cityLon?: number;
	hasLocation?: boolean;
	hasRegionCoordinates?: boolean;
	hasCityCoordinates?: boolean;
	connectedSinceMillis?: number;
};

function isFiniteCoordinate(lat: unknown, lon: unknown): boolean {
	const latitude = Number(lat);
	const longitude = Number(lon);
	return (
		Number.isFinite(latitude) &&
		Number.isFinite(longitude) &&
		latitude >= -90 &&
		latitude <= 90 &&
		longitude >= -180 &&
		longitude <= 180 &&
		// (0,0) is how the server spells "unknown"
		!(latitude === 0 && longitude === 0)
	);
}

function label(entry: ProviderLocationInfo, precision: "city" | "region"): string {
	const place = precision === "city" ? entry.city : entry.region;
	const country = entry.country || entry.countryCode || "";
	if (place && country) return `${place}, ${country}`;
	return place || country || "";
}

/**
 * The oldest connected provider that has coordinates, as a storable position.
 *
 * The sdk hands the list back sorted oldest-connected-first; it is re-sorted
 * here anyway so the answer does not depend on a caller in another repo
 * preserving that order. Entries with no coordinates are skipped rather than
 * ending the search — an oldest provider whose city the server cannot resolve
 * should not disable the feature.
 */
export function pickOldestLocatedProvider(list: unknown): GeoSyncPosition | null {
	if (!Array.isArray(list)) return null;
	const entries = list.filter(
		(entry): entry is ProviderLocationInfo => Boolean(entry) && typeof entry === "object",
	);
	const ordered = [...entries].sort((a, b) => {
		const left = Number(a.connectedSinceMillis);
		const right = Number(b.connectedSinceMillis);
		const leftKnown = Number.isFinite(left) && left > 0;
		const rightKnown = Number.isFinite(right) && right > 0;
		if (leftKnown && rightKnown) return left - right; // oldest connection first
		if (leftKnown) return -1;
		if (rightKnown) return 1;
		return 0;
	});

	for (const entry of ordered) {
		if (entry.hasCityCoordinates !== false && isFiniteCoordinate(entry.cityLat, entry.cityLon)) {
			return {
				lat: Number(entry.cityLat),
				lon: Number(entry.cityLon),
				accuracy: GEO_CITY_ACCURACY_M,
				precision: "city",
				label: label(entry, "city"),
				...(typeof entry.clientId === "string" ? { clientId: entry.clientId } : {}),
				updatedAt: Date.now(),
			};
		}
		if (
			entry.hasRegionCoordinates !== false &&
			isFiniteCoordinate(entry.regionLat, entry.regionLon)
		) {
			return {
				lat: Number(entry.regionLat),
				lon: Number(entry.regionLon),
				accuracy: GEO_REGION_ACCURACY_M,
				precision: "region",
				label: label(entry, "region"),
				...(typeof entry.clientId === "string" ? { clientId: entry.clientId } : {}),
				updatedAt: Date.now(),
			};
		}
	}
	return null;
}

export async function getGeoSyncEnabled(): Promise<boolean> {
	try {
		const stored = await chrome.storage.local.get(STORAGE_KEY_GEO_ENABLED);
		return stored[STORAGE_KEY_GEO_ENABLED] === true;
	} catch {
		return false;
	}
}

/** Turning the override off also drops the position: nothing keeps a location
 * the user stopped asking for. */
export async function setGeoSyncEnabled(enabled: boolean): Promise<void> {
	if (enabled) {
		await chrome.storage.local.set({ [STORAGE_KEY_GEO_ENABLED]: true });
		return;
	}
	await chrome.storage.local.set({ [STORAGE_KEY_GEO_ENABLED]: false });
	await clearGeoSyncPosition();
}

export async function getGeoSyncPosition(): Promise<GeoSyncPosition | null> {
	try {
		const stored = await chrome.storage.local.get(STORAGE_KEY_GEO_POSITION);
		const raw = stored[STORAGE_KEY_GEO_POSITION];
		if (!raw || typeof raw !== "object") return null;
		return raw as GeoSyncPosition;
	} catch {
		return null;
	}
}

export async function clearGeoSyncPosition(): Promise<void> {
	try {
		await chrome.storage.local.remove(STORAGE_KEY_GEO_POSITION);
	} catch {
		// storage unavailable
	}
}

/**
 * Store the position derived from a pushed provider list. A no-op while the
 * toggle is off, so a page cannot install coordinates the user never asked
 * for. Returns what was stored (null = nothing usable).
 */
export async function storeProviderLocations(list: unknown): Promise<GeoSyncPosition | null> {
	if (!(await getGeoSyncEnabled())) return null;
	const position = pickOldestLocatedProvider(list);
	if (!position) {
		await clearGeoSyncPosition();
		return null;
	}
	const previous = await getGeoSyncPosition();
	if (
		previous &&
		previous.lat === position.lat &&
		previous.lon === position.lon &&
		previous.accuracy === position.accuracy &&
		previous.label === position.label
	) {
		// Same place. Every write fires chrome.storage.onChanged in every frame
		// of every tab, and providers turn over constantly, so only re-stamp
		// when the freshness bound is getting close.
		if (position.updatedAt - Number(previous.updatedAt) < REFRESH_STAMP_AFTER_MS) {
			return previous;
		}
		const restamped = { ...previous, updatedAt: position.updatedAt };
		await chrome.storage.local.set({ [STORAGE_KEY_GEO_POSITION]: restamped });
		return restamped;
	}
	await chrome.storage.local.set({ [STORAGE_KEY_GEO_POSITION]: position });
	return position;
}
