import { useState, useRef, useCallback, useEffect } from "react";
import { useAPI } from "@urnetwork/sdk/react";
import { loadSdk, preloadSdk } from "./sdk-wasm";
import {
	emptyLocations,
	groupLocations,
	type FilteredLocationsSorted,
	type FindLocationsResult,
} from "./locations";

export type { FilteredLocationsSorted, RegionGroup } from "./locations";

const DEBOUNCE_MS = 400;

// The location list: the api result (useAPI().client, the sdk's generated
// client) grouped and ordered by the sdk's shared location logic in the wasm
// (utils/locations.ts), so the popup lists locations exactly like the apps.
export function useProviderListEnhanced() {
	const api = useAPI();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<Error | null>(null);
	const [filteredLocations, setFilteredLocations] = useState<FilteredLocationsSorted>(emptyLocations);
	const [query, setQuery] = useState("");

	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const requestIdRef = useRef(0);

	// the wasm loads after the first paint, overlapping the first api call
	useEffect(() => {
		preloadSdk();
	}, []);

	const fetchLocations = useCallback(async (searchQuery: string, reqId: number) => {
		setLoading(true);
		setError(null);

		try {
			// public routes; a non-2xx or network failure rejects (URNetworkApiError)
			const request: Promise<FindLocationsResult> =
				searchQuery.length === 0
					? api.client.networkProviderLocations()
					: api.client.networkFindProviderLocations({
							query: searchQuery,
							enable_max_distance_fraction: true,
							max_distance_fraction: 0.5,
						});
			const [result, sdk] = await Promise.all([request, loadSdk()]);

			if (reqId === requestIdRef.current) {
				setFilteredLocations(groupLocations(sdk, result, searchQuery));
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
	}, [api]);

	useEffect(() => {
		if (timeoutRef.current) clearTimeout(timeoutRef.current);

		requestIdRef.current += 1;
		const reqId = requestIdRef.current;

		// debounce typing; the unsearched browse (the popup opening, a cleared
		// search) loads at once
		timeoutRef.current = setTimeout(() => {
			fetchLocations(query, reqId);
		}, query.length === 0 ? 0 : DEBOUNCE_MS);

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
