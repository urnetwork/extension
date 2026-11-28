// The location list names a country in the UI language (support inbox 8621):
// the browser's own name for its code, the server's English name the fallback
// and every other location's name.
import { describe, expect, it } from "vitest";
import { locationDisplayName } from "@/utils/i18n";

const germany = { location_type: "country", country_code: "de", name: "Germany" };

describe("locationDisplayName", () => {
	it("names a country in the UI language", () => {
		expect(locationDisplayName(germany, "tr")).toBe("Almanya");
		expect(locationDisplayName(germany, "fa")).toBe(new Intl.DisplayNames(["fa"], { type: "region" }).of("DE"));
		expect(locationDisplayName(germany, "fa")).not.toBe("Germany");
		expect(locationDisplayName(germany, "en")).toBe("Germany");
	});

	it("keeps the server's name for a code the browser does not name", () => {
		expect(locationDisplayName({ location_type: "country", country_code: "", name: "Germany" }, "tr")).toBe("Germany");
		expect(locationDisplayName({ location_type: "country", country_code: "deu", name: "Germany" }, "tr")).toBe("Germany");
		expect(locationDisplayName({ location_type: "country", country_code: "de", name: "Germany" }, "not a tag")).toBe("Germany");
	});

	it("keeps the server's name for a region, city, group or device", () => {
		// a city carries its country's code, which must not rename it
		expect(locationDisplayName({ location_type: "city", country_code: "de", name: "Berlin" }, "tr")).toBe("Berlin");
		expect(locationDisplayName({ name: "Strong Privacy" }, "tr")).toBe("Strong Privacy");
		expect(locationDisplayName({}, "tr")).toBe("");
	});
});
