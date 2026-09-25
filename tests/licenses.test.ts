import { describe, expect, it } from "vitest";
import {
	licenseKey,
	licenseSections,
	licenseSubtitle,
	normalizeLicenses,
	safeProjectUrl,
	type LicenseInfo,
} from "@/utils/licenses";

function entry(fields: Partial<LicenseInfo>): LicenseInfo {
	return {
		name: "x",
		version: "",
		kind: "software",
		origin: "npm-extension",
		url: "",
		spdx: "",
		copyright: "",
		notice: "",
		text: "",
		...fields,
	};
}

describe("licenseSections", () => {
	it("puts data first and keeps the sdk's order in each section", () => {
		const list = [
			entry({ name: "GeoLite2 by MaxMind", kind: "data", notice: "This product includes GeoLite2 data" }),
			entry({ name: "GeoNames", kind: "data" }),
			entry({ name: "lit" }),
			entry({ name: "Some Font", kind: "font" }),
			entry({ name: "react" }),
		];
		const { data, software } = licenseSections(list);
		expect(data.map((l) => l.name)).toEqual(["GeoLite2 by MaxMind", "GeoNames"]);
		// everything that is not data is listed as software, fonts included
		expect(software.map((l) => l.name)).toEqual(["lit", "Some Font", "react"]);
	});
});

describe("licenseSubtitle", () => {
	it("joins version and spdx, omitting empties", () => {
		expect(licenseSubtitle({ version: "3.3.2", spdx: "BSD-3-Clause" })).toBe("3.3.2 · BSD-3-Clause");
		expect(licenseSubtitle({ version: "", spdx: "CC-BY-4.0" })).toBe("CC-BY-4.0");
		expect(licenseSubtitle({ version: "v1.6.0", spdx: " " })).toBe("v1.6.0");
		expect(licenseSubtitle({ version: "", spdx: "" })).toBe("");
	});
});

describe("licenseKey", () => {
	it("distinguishes the same package at two versions", () => {
		expect(licenseKey(entry({ name: "a", version: "1" }))).not.toBe(
			licenseKey(entry({ name: "a", version: "2" })),
		);
	});
});

describe("safeProjectUrl", () => {
	it("only allows web urls", () => {
		expect(safeProjectUrl("https://www.maxmind.com")).toBe("https://www.maxmind.com/");
		expect(safeProjectUrl("http://example.com/x")).toBe("http://example.com/x");
		expect(safeProjectUrl("javascript:alert(1)")).toBeNull();
		expect(safeProjectUrl("data:text/html,hi")).toBeNull();
		expect(safeProjectUrl("chrome-extension://abc/popup.html")).toBeNull();
		expect(safeProjectUrl("not a url")).toBeNull();
		expect(safeProjectUrl("")).toBeNull();
		expect(safeProjectUrl(undefined)).toBeNull();
	});
});

describe("normalizeLicenses", () => {
	it("keeps string fields, defaults missing ones, drops unnamed entries", () => {
		const out = normalizeLicenses([
			{ name: "GeoLite2 by MaxMind", kind: "data", notice: "required", spdx: 5 },
			{ kind: "software" },
			null,
			"junk",
		]);
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual(
			entry({ name: "GeoLite2 by MaxMind", kind: "data", notice: "required", origin: "" }),
		);
		expect(normalizeLicenses(undefined)).toEqual([]);
	});
});
