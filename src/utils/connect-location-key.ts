// A connect location as a comparable key. The install's one hosted proxy
// client is reused only at the location its hosted device runs at
// (bridge/background.ts); any other pick moves the device or replaces the
// client.
import type { ConnectLocation } from "./sdk-types";

export const BEST_AVAILABLE_LOCATION_KEY = "best_available";

export function connectLocationKey(location: ConnectLocation | null | undefined): string {
	const id = location?.connect_location_id as Record<string, unknown> | null | undefined;
	if (!id || id.best_available) return BEST_AVAILABLE_LOCATION_KEY;
	const entries = Object.entries(id)
		.filter(([, value]) => value !== undefined && value !== null && value !== false && value !== "")
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	if (entries.length === 0) return BEST_AVAILABLE_LOCATION_KEY;
	return JSON.stringify(Object.fromEntries(entries));
}

/** The key of a page location id (null for best available). */
export function locationIdKey(locationId: string | null | undefined): string {
	return locationId
		? connectLocationKey({ connect_location_id: { location_id: locationId } } as ConnectLocation)
		: BEST_AVAILABLE_LOCATION_KEY;
}

/** The page location id of a connect location, null when it has none. */
export function connectLocationPageId(location: ConnectLocation | null | undefined): string | null {
	const locationId = location?.connect_location_id?.location_id;
	return typeof locationId === "string" && locationId !== "" ? locationId : null;
}
