// The location list's shape, from the sdk's shared location logic.
//
// Grouping and order are not decided here: they are the Go sdk's
// GetFilteredLocationsFromResult (what android, apple, linux, windows and
// ur.io render), run in the wasm as URNetwork#filteredLocations. This module
// only adapts its result to what ConnectScreen renders: the sdk hands back
// ConnectLocationInfo (ids, name, type, country code, provider count), and
// the screen needs the full location the popup persists and connects with
// (stable / strong_privacy flags, region/country ids), so every entry is
// joined back to its record in the api result by id.
import type { ConnectLocationInfo, FilteredLocations, OpenAPI } from "@urnetwork/sdk";
import type { ConnectLocation } from "./sdk-types";

/** GET /network/provider-locations, POST /network/find-provider-locations */
export type FindLocationsResult = OpenAPI.FindLocationsResult;

/** a region of a search result and its cities; region null = "Other" */
export interface RegionGroup {
	region: ConnectLocation | null;
	cities: ConnectLocation[];
}

/** what ConnectScreen renders; a null list is an empty section */
export interface FilteredLocationsSorted {
	best_matches: ConnectLocation[] | null;
	promoted: ConnectLocation[] | null;
	countries: ConnectLocation[] | null;
	cities: ConnectLocation[] | null;
	regions: ConnectLocation[] | null;
	region_groups: RegionGroup[] | null;
	devices: ConnectLocation[] | null;
}

export const emptyLocations: FilteredLocationsSorted = {
	best_matches: null,
	promoted: null,
	countries: null,
	cities: null,
	regions: null,
	region_groups: null,
	devices: null,
};

/** The subset of URNetwork the list needs (a fake in tests). */
export type LocationsSdk = {
	filteredLocations(result: FindLocationsResult, filter: string): FilteredLocations | null;
};

// ids are udids; compare them case-insensitively in case the api and the sdk
// format them differently
const idKey = (kind: "location" | "group" | "client", id: string | null | undefined) =>
	id ? `${kind}:${id.toLowerCase()}` : null;

/** Every location of the api result as the popup's ConnectLocation, by id. */
function indexResult(result: FindLocationsResult): Map<string, ConnectLocation> {
	const index = new Map<string, ConnectLocation>();
	for (const group of result.groups ?? []) {
		const key = idKey("group", group.location_group_id);
		if (!key) continue;
		index.set(key, {
			connect_location_id: { location_group_id: group.location_group_id },
			name: group.name,
			provider_count: group.provider_count,
			promoted: group.promoted,
			match_distance: group.match_distance,
			stable: false,
			strong_privacy: false,
		});
	}
	for (const loc of result.locations ?? []) {
		const key = idKey("location", loc.location_id);
		if (!key) continue;
		index.set(key, {
			connect_location_id: { location_id: loc.location_id },
			location_type: loc.location_type,
			name: loc.name,
			city: loc.city,
			region: loc.region,
			country: loc.country,
			country_code: loc.country_code,
			city_location_id: loc.city_location_id,
			region_location_id: loc.region_location_id,
			country_location_id: loc.country_location_id,
			provider_count: loc.provider_count,
			match_distance: loc.match_distance,
			stable: loc.stable ?? false,
			strong_privacy: loc.strong_privacy ?? false,
		});
	}
	for (const device of result.devices ?? []) {
		const key = idKey("client", device.client_id);
		if (!key) continue;
		index.set(key, {
			connect_location_id: { client_id: device.client_id },
			name: device.device_name,
			stable: false,
			strong_privacy: false,
		});
	}
	return index;
}

function toConnectLocation(
	info: ConnectLocationInfo,
	index: Map<string, ConnectLocation>,
): ConnectLocation {
	const key =
		idKey("location", info.locationId) ??
		idKey("group", info.locationGroupId) ??
		idKey("client", info.clientId);
	const record = key ? index.get(key) : undefined;
	if (record) return record;
	// not in the result (cannot happen for a result the sdk just read); keep
	// what the sdk knows
	return {
		connect_location_id: {
			location_id: info.locationId,
			location_group_id: info.locationGroupId,
			client_id: info.clientId,
		},
		name: info.name,
		location_type: info.locationType || undefined,
		country_code: info.countryCode || undefined,
		provider_count: info.providerCount,
		stable: false,
		strong_privacy: false,
	};
}

/**
 * The sdk's grouping of `result` (URNetwork#filteredLocations) as the screen's
 * lists, in the sdk's order. `result` must be the value the sdk grouped.
 */
export function adaptFilteredLocations(
	filtered: FilteredLocations,
	result: FindLocationsResult,
): FilteredLocationsSorted {
	const index = indexResult(result);
	const list = (infos: ConnectLocationInfo[] | null | undefined) => {
		const locations = (infos ?? []).map((info) => toConnectLocation(info, index));
		return locations.length > 0 ? locations : null;
	};
	const regionGroups = (filtered.regionGroups ?? []).map((group) => ({
		region: group.region ? toConnectLocation(group.region, index) : null,
		cities: (group.cities ?? []).map((city) => toConnectLocation(city, index)),
	}));
	return {
		best_matches: list(filtered.bestMatches),
		promoted: list(filtered.promoted),
		countries: list(filtered.countries),
		cities: list(filtered.cities),
		regions: list(filtered.regions),
		region_groups: regionGroups.length > 0 ? regionGroups : null,
		devices: list(filtered.devices),
	};
}

/**
 * Group an api result for the screen with the sdk. `filter` is the search
 * text the result answers ("" for the unsearched browse).
 */
export function groupLocations(
	sdk: LocationsSdk,
	result: FindLocationsResult,
	filter: string,
): FilteredLocationsSorted {
	const filtered = sdk.filteredLocations(result, filter);
	if (!filtered) {
		throw new Error("The sdk could not read the locations result");
	}
	return adaptFilteredLocations(filtered, result);
}
