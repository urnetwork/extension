const API_URL_KEY = "custom_api_url";
const DEFAULT_API_HOST = "api.bringyour.com";

export const OFFICIAL_EXTENSION_IDS = {
	chrome: "kpnklgbgjkihebbieiggfeokkddjbkfb",
	firefox: "urnetwork@bringyour.com",
} as const;

export function getDefaultApiHost(): string {
	return DEFAULT_API_HOST;
}

export function buildApiBaseUrl(host: string): string {
	return `https://${host}`;
}

export async function getStoredApiHost(): Promise<string> {
	try {
		const result = await chrome.storage.local.get(API_URL_KEY);
		const value = result[API_URL_KEY];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	} catch {
		// fall through
	}
	return DEFAULT_API_HOST;
}

export async function setStoredApiHost(host: string): Promise<void> {
	const trimmed = host.trim();
	if (!trimmed || trimmed === DEFAULT_API_HOST) {
		await chrome.storage.local.remove(API_URL_KEY);
	} else {
		await chrome.storage.local.set({ [API_URL_KEY]: trimmed });
	}
}

export async function clearStoredApiHost(): Promise<void> {
	await chrome.storage.local.remove(API_URL_KEY);
}
