// Licenses — the open source software and data attributions the extension
// publishes under the menu's Licenses screen.
//
// The list is not maintained here: it is sdk/license.yml, embedded in the sdk
// wasm and read with `URNetwork#licenses("extension")`. The extension holds no
// device (the ur.io app tab owns the DeviceRemote, see utils/geo-sync.ts), so
// it uses the package-level call. The build keeps the list honest:
// `go -C ../sdk run ./licenses -check extension` (Makefile) fails when the
// extension's runtime npm dependencies drift from license.yml.
//
// The wasm is the popup's shared instance (utils/sdk-wasm.ts), which the
// location list has usually loaded already by the time this screen opens.
import { loadSdk } from "./sdk-wasm";

/**
 * The fields consumed from the sdk's `LicenseInfo` (sdk/js/src/types.ts),
 * validated by normalizeLicenses: the list crosses the wasm boundary untyped.
 */
export type LicenseInfo = {
	name: string;
	version: string;
	/** "data" | "software" | "font" */
	kind: string;
	origin: string;
	url: string;
	/** SPDX expression; empty when the text is not a standard license */
	spdx: string;
	/** newline separated */
	copyright: string;
	/** must be shown verbatim when non-empty (e.g. the MaxMind attribution) */
	notice: string;
	text: string;
};

export type LicenseSections = {
	/** kind === "data", in sdk order (the GeoLite2 attribution first) */
	data: LicenseInfo[];
	/** everything else, in sdk order */
	software: LicenseInfo[];
};

/** Split the sdk list into the two screen sections, keeping the sdk's order. */
export function licenseSections(licenses: readonly LicenseInfo[]): LicenseSections {
	const data: LicenseInfo[] = [];
	const software: LicenseInfo[] = [];
	for (const license of licenses) {
		(license.kind === "data" ? data : software).push(license);
	}
	return { data, software };
}

/** The row's secondary line: "version · spdx", omitting empty parts. */
export function licenseSubtitle(license: Pick<LicenseInfo, "version" | "spdx">): string {
	return [license.version, license.spdx]
		.map((part) => (part ?? "").trim())
		.filter((part) => part.length > 0)
		.join(" · ");
}

/** A stable React key: the same name can appear at two versions. */
export function licenseKey(license: Pick<LicenseInfo, "origin" | "name" | "version">): string {
	return `${license.origin}|${license.name}|${license.version}`;
}

/**
 * The project page link, or null when it is not an http(s) URL. The list is
 * generated from package metadata; never hand anything but a web URL to an
 * <a href>.
 */
export function safeProjectUrl(url: string | undefined | null): string | null {
	if (!url) return null;
	try {
		const parsed = new URL(url.trim());
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
		return parsed.href;
	} catch {
		return null;
	}
}

function normalize(value: unknown): LicenseInfo | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const field = (name: keyof LicenseInfo) =>
		typeof raw[name] === "string" ? (raw[name] as string) : "";
	const license: LicenseInfo = {
		name: field("name"),
		version: field("version"),
		kind: field("kind"),
		origin: field("origin"),
		url: field("url"),
		spdx: field("spdx"),
		copyright: field("copyright"),
		notice: field("notice"),
		text: field("text"),
	};
	return license.name ? license : null;
}

/** Validate what the wasm handed back; drops anything without a name. */
export function normalizeLicenses(value: unknown): LicenseInfo[] {
	if (!Array.isArray(value)) return [];
	return value.map(normalize).filter((license): license is LicenseInfo => license !== null);
}

/**
 * The extension's license list, from the sdk wasm (the popup's one instance,
 * utils/sdk-wasm.ts). A failure is not cached, so the screen's retry loads
 * again.
 */
export async function loadLicenses(): Promise<LicenseInfo[]> {
	const sdk = await loadSdk();
	const licenses = normalizeLicenses(sdk.licenses("extension"));
	if (licenses.length === 0) {
		throw new Error("the sdk returned no licenses");
	}
	return licenses;
}
