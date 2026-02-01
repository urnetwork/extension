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
