// The location list is grouped and ordered by the sdk's shared location logic
// (Go GetFilteredLocationsFromResult, run in the wasm as
// URNetwork#filteredLocations); utils/locations.ts only adapts its result to
// the screen. The adapter is tested against hand-built sdk output, and the
// whole path against the real wasm from the sibling sdk checkout.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { FilteredLocations, URNetwork } from "@urnetwork/sdk";
import {
	adaptFilteredLocations,
	groupLocations,
	type FindLocationsResult,
	type LocationsSdk,
} from "@/utils/locations";
import { SDK_JS } from "../sdk-source";

const ids = {
	de: "0190a000-0000-7000-8000-000000000001",
	us: "0190a000-0000-7000-8000-000000000002",
	berlinRegion: "0190a000-0000-7000-8000-000000000003",
	berlinCity: "0190a000-0000-7000-8000-000000000004",
	bavaria: "0190a000-0000-7000-8000-000000000005",
	bamberg: "0190a000-0000-7000-8000-000000000006",
	bayreuth: "0190a000-0000-7000-8000-000000000007",
	bergen: "0190a000-0000-7000-8000-000000000008",
	berkeley: "0190a000-0000-7000-8000-000000000009",
	group: "0190a000-0000-7000-8000-00000000000a",
	device: "0190a000-0000-7000-8000-00000000000b",
};

// a search for "ber": exact matches, regions with their cities, and cities
// whose region is not in the result
const searchResult: FindLocationsResult = {
	groups: [{ location_group_id: ids.group, name: "Strong Privacy", provider_count: 700, promoted: true, match_distance: 3 }],
	locations: [
		{ location_id: ids.de, location_type: "country", name: "Germany", country_code: "de", provider_count: 450, match_distance: 4, stable: true, strong_privacy: false },
		{ location_id: ids.us, location_type: "country", name: "United States", country_code: "us", provider_count: 900, match_distance: 5, stable: true, strong_privacy: false },
		{ location_id: ids.berlinRegion, location_type: "region", name: "Berlin", country_code: "de", country_location_id: ids.de, provider_count: 200, match_distance: 0, stable: true, strong_privacy: true },
		{ location_id: ids.berlinCity, location_type: "city", name: "Berlin", region: "Berlin", region_location_id: ids.berlinRegion, country_code: "de", country_location_id: ids.de, provider_count: 190, match_distance: 0, stable: true, strong_privacy: false },
		{ location_id: ids.bavaria, location_type: "region", name: "Bavaria", country_code: "de", country_location_id: ids.de, provider_count: 150, match_distance: 3, stable: true, strong_privacy: true },
		{ location_id: ids.bayreuth, location_type: "city", name: "Bayreuth", region: "Bavaria", region_location_id: ids.bavaria, country_code: "de", country_location_id: ids.de, provider_count: 3, match_distance: 2, stable: false, strong_privacy: false },
		{ location_id: ids.bamberg, location_type: "city", name: "Bamberg", region: "Bavaria", region_location_id: ids.bavaria, country_code: "de", country_location_id: ids.de, provider_count: 15, match_distance: 2, stable: true, strong_privacy: false },
		{ location_id: ids.bergen, location_type: "city", name: "Bergen", region: "Vestland", country_code: "no", provider_count: 22, match_distance: 1, stable: true, strong_privacy: false },
		{ location_id: ids.berkeley, location_type: "city", name: "Berkeley", region: "California", country_code: "us", country_location_id: ids.us, provider_count: 30, match_distance: 1, stable: true, strong_privacy: false },
	],
	devices: [{ client_id: ids.device, device_name: "My laptop" }],
	country_count: 2,
	region_count: 2,
	city_count: 5,
	stable_count: 8,
	strong_privacy_count: 2,
};

const info = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
	locationId: id,
	name,
	locationType: "",
	countryCode: "",
	providerCount: 0,
	colorHex: "",
	...extra,
});

describe("adaptFilteredLocations", () => {
	it("keeps the sdk's order and joins every entry to its api record", () => {
		const filtered: FilteredLocations = {
			bestMatches: [info(ids.berlinCity, "Berlin"), info(ids.berlinRegion, "Berlin")],
			promoted: [{ ...info("", "Strong Privacy"), locationId: undefined, locationGroupId: ids.group }],
			countries: [info(ids.us, "United States"), info(ids.de, "Germany")],
			regions: [],
			cities: [],
			devices: [{ ...info("", "My laptop"), locationId: undefined, clientId: ids.device }],
			regionGroups: [],
		};
		const adapted = adaptFilteredLocations(filtered, searchResult);
		expect(adapted.best_matches?.map((l) => l.connect_location_id?.location_id)).toEqual([
			ids.berlinCity,
			ids.berlinRegion,
		]);
		// the full api record: flags and ids the screen and buildAuthParams use
		expect(adapted.best_matches?.[1]).toMatchObject({
			name: "Berlin",
			location_type: "region",
			strong_privacy: true,
			stable: true,
			provider_count: 200,
		});
		expect(adapted.countries?.map((l) => l.name)).toEqual(["United States", "Germany"]);
		expect(adapted.promoted?.[0].connect_location_id).toEqual({ location_group_id: ids.group });
		expect(adapted.devices?.[0]).toMatchObject({ name: "My laptop", connect_location_id: { client_id: ids.device } });
		// empty sections are null, which the screen skips
		expect(adapted.regions).toBeNull();
		expect(adapted.cities).toBeNull();
		expect(adapted.region_groups).toBeNull();
	});

	it("keeps the region-less group as region null", () => {
		const filtered: FilteredLocations = {
			bestMatches: [],
			promoted: [],
			countries: [],
			regions: [info(ids.bavaria, "Bavaria")],
			cities: [info(ids.bamberg, "Bamberg"), info(ids.bergen, "Bergen")],
			devices: [],
			regionGroups: [
				{ region: info(ids.bavaria, "Bavaria"), cities: [info(ids.bamberg, "Bamberg")] },
				{ region: null, cities: [info(ids.bergen, "Bergen")] },
			],
		};
		const adapted = adaptFilteredLocations(filtered, searchResult);
		expect(adapted.region_groups?.map((g) => [g.region?.name ?? null, g.cities.map((c) => c.name)])).toEqual([
			["Bavaria", ["Bamberg"]],
			[null, ["Bergen"]],
		]);
	});

	it("matches ids case-insensitively and falls back to the sdk's fields", () => {
		const filtered: FilteredLocations = {
			bestMatches: [],
			promoted: [],
			countries: [
				info(ids.de.toUpperCase(), "Germany"),
				info("0190a000-0000-7000-8000-0000000000ff", "Nowhere", { countryCode: "zz", providerCount: 4, locationType: "country" }),
			],
			regions: [],
			cities: [],
			devices: [],
			regionGroups: [],
		};
		const [germany, nowhere] = adaptFilteredLocations(filtered, searchResult).countries ?? [];
		expect(germany.provider_count).toBe(450);
		expect(nowhere).toMatchObject({ name: "Nowhere", country_code: "zz", provider_count: 4, stable: false });
	});
});

describe("groupLocations", () => {
	it("throws when the sdk cannot read the result", () => {
		const sdk: LocationsSdk = { filteredLocations: () => null };
		expect(() => groupLocations(sdk, searchResult, "ber")).toThrow();
	});
});

// The real thing: the sdk wasm from ../sdk/js/wasm (scripts/sync-sdk.js
// builds it). Skipped when it has not been built.
const wasmDir = path.join(SDK_JS, "wasm");
const haveWasm = fs.existsSync(path.join(wasmDir, "sdk.wasm")) && fs.existsSync(path.join(wasmDir, "wasm_exec.js"));

describe.skipIf(!haveWasm)("the sdk wasm's grouping", () => {
	let sdk: URNetwork;
	beforeAll(async () => {
		const { URNetwork } = await import("@urnetwork/sdk");
		sdk = await URNetwork.init({
			wasmUrl: pathToFileURL(path.join(wasmDir, "sdk.wasm")).href,
			wasmExecUrl: pathToFileURL(path.join(wasmDir, "wasm_exec.js")).href,
		});
	}, 60_000);

	it("orders a search like the apps and groups cities under their regions", () => {
		const grouped = groupLocations(sdk, searchResult, "ber");
		const names = (list: { name?: string }[] | null) => (list ?? []).map((l) => l.name);

		// exact matches (distance 0) first, then by provider count
		expect(names(grouped.best_matches)).toEqual(["Berlin", "Berlin"]);
		expect(grouped.best_matches?.[0].location_type).toBe("region");
		// match distance <= 1 before the rest, then provider count, then name
		expect(names(grouped.countries)).toEqual(["United States", "Germany"]);
		expect(names(grouped.cities)).toEqual(["Berkeley", "Bergen", "Bamberg", "Bayreuth"]);
		expect(names(grouped.regions)).toEqual(["Bavaria"]);
		expect(
			(grouped.region_groups ?? []).map((g) => [g.region?.name ?? null, g.cities.map((c) => c.name)]),
		).toEqual([
			["Bavaria", ["Bamberg", "Bayreuth"]],
			[null, ["Berkeley", "Bergen"]],
		]);
		expect(names(grouped.devices)).toEqual(["My laptop"]);
		// the region-less cities keep their api records
		expect(grouped.region_groups?.[1].cities[1]).toMatchObject({ region: "Vestland", country_code: "no", stable: true });
	});

	it("shows countries, not regions or cities, when not searching", () => {
		const grouped = groupLocations(sdk, searchResult, "");
		expect(grouped.best_matches).toBeNull();
		expect((grouped.promoted ?? []).map((l) => l.name)).toEqual(["Strong Privacy"]);
		expect((grouped.countries ?? []).length).toBe(2);
		expect(grouped.cities).toBeNull();
		expect(grouped.regions).toBeNull();
		expect(grouped.region_groups).toBeNull();
	});
});
