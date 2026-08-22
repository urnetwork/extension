import { useState, useRef, useCallback, useEffect } from "react";
import { useAPI } from "@urnetwork/sdk-js/react";
import type {
	ConnectLocation,
	FindLocationsResult,
} from "node_modules/@urnetwork/sdk-js/dist/generated";

const DEBOUNCE_MS = 400;
const API_BASE = "https://api.bringyour.com";

export interface RegionGroup {
	region: ConnectLocation;
	cities: ConnectLocation[];
}

export interface FilteredLocationsSorted {
	best_matches: ConnectLocation[] | null;
	promoted: ConnectLocation[] | null;
	countries: ConnectLocation[] | null;
	cities: ConnectLocation[] | null;
	regions: ConnectLocation[] | null;
	region_groups: RegionGroup[] | null;
	devices: ConnectLocation[] | null;
}

const emptyLocations: FilteredLocationsSorted = {
	best_matches: null,
	promoted: null,
	countries: null,
	cities: null,
	regions: null,
	region_groups: null,
	devices: null,
};

function sortByPopularity(locations: ConnectLocation[]): ConnectLocation[] {
	return [...locations].sort((a, b) => (b.provider_count ?? 0) - (a.provider_count ?? 0));
}

function groupCitiesByRegion(
	regions: ConnectLocation[],
	cities: ConnectLocation[],
): RegionGroup[] {
	const groups: RegionGroup[] = [];
	const assignedCityIds = new Set<string>();

	const sortedRegions = sortByPopularity(regions);

	for (const region of sortedRegions) {
		const regionId = region.connect_location_id?.location_id;
		const matchingCities = cities.filter((city) => {
			if (city.region_location_id === regionId) return true;
			if (city.region && region.name && city.region === region.name) return true;
			return false;
		});

		const sortedCities = sortByPopularity(matchingCities);
		for (const city of sortedCities) {
			const cityId = city.connect_location_id?.location_id ?? city.name ?? "";
			assignedCityIds.add(cityId);
		}

		groups.push({ region, cities: sortedCities });
	}

	const unassignedCities = cities.filter((city) => {
		const cityId = city.connect_location_id?.location_id ?? city.name ?? "";
		return !assignedCityIds.has(cityId);
	});

	if (unassignedCities.length > 0) {
		const otherRegion: ConnectLocation = {
			connect_location_id: { location_id: "__other__" },
			name: "Other",
			provider_count: unassignedCities.reduce((sum, c) => sum + (c.provider_count ?? 0), 0),
			stable: false,
			strong_privacy: false,
		};
		groups.push({ region: otherRegion, cities: sortByPopularity(unassignedCities) });
	}

	return groups;
}

export function useProviderListEnhanced() {
	const api = useAPI();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const [filteredLocations, setFilteredLocations] = useState<FilteredLocationsSorted>(emptyLocations);
	const [query, setQuery] = useState("");

	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestIdRef = useRef(0);

	const filterLocations = useCallback((result: FindLocationsResult, searchQuery: string): FilteredLocationsSorted => {
		const bestMatch: ConnectLocation[] = [];
		const promoted: ConnectLocation[] = [];
		const countries: ConnectLocation[] = [];
		const cities: ConnectLocation[] = [];
		const regions: ConnectLocation[] = [];
		const devices: ConnectLocation[] = [];

		if (result.groups) {
			for (const group of result.groups) {
				const location: ConnectLocation = {
					connect_location_id: { location_group_id: group.location_group_id },
					name: group.name,
					provider_count: group.provider_count,
					promoted: group.promoted,
					match_distance: group.match_distance,
					stable: false,
					strong_privacy: false,
				};
				if (group.match_distance === 0 && searchQuery !== "") {
					bestMatch.push(location);
				} else if (group.promoted) {
					promoted.push(location);
				}
			}
		}

		if (result.locations) {
			for (const loc of result.locations) {
				const location: ConnectLocation = {
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
					stable: loc.stable,
					strong_privacy: loc.strong_privacy,
				};

				if (loc.match_distance === 0 && searchQuery !== "") {
					bestMatch.push(location);
				} else if (loc.location_type === "country") {
					countries.push(location);
				} else if (loc.location_type === "city") {
					cities.push(location);
				} else if (loc.location_type === "region") {
					regions.push(location);
				}
			}
		}

		if (result.devices) {
			for (const dev of result.devices) {
				devices.push({
					connect_location_id: { client_id: dev.client_id },
					name: dev.device_name,
					stable: false,
					strong_privacy: false,
				});
			}
		}

		const sortedCountries = sortByPopularity(countries);
		const sortedCities = sortByPopularity(cities);
		const sortedRegions = sortByPopularity(regions);
		const sortedBestMatches = sortByPopularity(bestMatch);

		const isSearch = searchQuery.length > 0;
		const regionGroups = isSearch && (regions.length > 0 || cities.length > 0)
			? groupCitiesByRegion(sortedRegions, sortedCities)
			: null;

		return {
			best_matches: sortedBestMatches.length > 0 ? sortedBestMatches : null,
			promoted: promoted.length > 0 ? promoted : null,
			countries: sortedCountries.length > 0 ? sortedCountries : null,
			cities: !isSearch && sortedCities.length > 0 ? sortedCities : (isSearch ? null : (sortedCities.length > 0 ? sortedCities : null)),
			regions: !isSearch && sortedRegions.length > 0 ? sortedRegions : null,
			region_groups: regionGroups,
			devices: devices.length > 0 ? devices : null,
		};
	}, []);

	const fetchLocations = useCallback(async (searchQuery: string, reqId: number) => {
		setLoading(true);
		setError(null);

		try {
			let result: FindLocationsResult;

			if (searchQuery.length === 0) {
				result = await api.networkProviderLocations();
			} else {
				const response = await fetch(`${API_BASE}/network/find-provider-locations`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						query: searchQuery,
						enable_max_distance_fraction: true,
						max_distance_fraction: 0.5,
					}),
				});

				if (!response.ok) {
					throw new Error(`Search failed: ${response.status}`);
				}

				result = await response.json();
			}

			if (reqId === requestIdRef.current) {
				setFilteredLocations(filterLocations(result, searchQuery));
			}
		} catch (err) {
			if (reqId === requestIdRef.current) {
				setError(err instanceof Error ? err : new Error("Failed to load locations"));
				setFilteredLocations(emptyLocations);
			}
		} finally {
			if (reqId === requestIdRef.current) {
				setLoading(false);
			}
		}
	}, [api, filterLocations]);

	useEffect(() => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);

		requestIdRef.current += 1;
		const reqId = requestIdRef.current;

		timeoutRef.current = setTimeout(() => {
			fetchLocations(query, reqId);
		}, DEBOUNCE_MS);

		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, [query, fetchLocations]);

	const retry = useCallback(async () => {
		requestIdRef.current += 1;
		await fetchLocations(query, requestIdRef.current);
	}, [query, fetchLocations]);

	return { query, setQuery, filteredLocations, loading, error, retry };
}
