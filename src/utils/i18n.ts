/**
 * Get a localized message
 * Works in Chrome extension, Electron, and web contexts
 */
export function getMessage(
	key: string,
	substitutions?: string | string[],
): string {
	// Chrome Extension context
	if (typeof chrome !== "undefined" && chrome.i18n) {
		return chrome.i18n.getMessage(key, substitutions);
	}

	// Electron/Web context (fallback to i18next or other library)
	// For now, return the key as fallback
	console.warn(`Localization not available: ${key}`);
	return key;
}

// Helper for common patterns
export function useI18n() {
	return { getMessage };
}

/**
 * The language the extension's own strings are shown in: the browser's UI
 * language, which picks the _locales catalog getMessage reads.
 */
export function uiLanguage(): string {
	if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
		return chrome.i18n.getUILanguage();
	}
	return typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
}

/**
 * The name the location list shows for a location (support inbox 8621). A
 * country reads in the UI language, by the browser's own name for its code
 * (Intl.DisplayNames, the platform locale data the apps also name a country
 * with). The server's English name stays the fallback, for a code the browser
 * does not name and for every region, city, group and device, which it cannot
 * name.
 */
export function locationDisplayName(
	location: { location_type?: string; country_code?: string; name?: string },
	language: string = uiLanguage(),
): string {
	const name = location.name ?? "";
	const code = (location.country_code ?? "").toUpperCase();
	if (location.location_type !== "country" || !/^[A-Z]{2}$/.test(code)) return name;
	try {
		const localized = new Intl.DisplayNames([language], { type: "region", fallback: "none" }).of(code);
		return localized || name;
	} catch {
		// an unknown language tag or an engine without region names
		return name;
	}
}
