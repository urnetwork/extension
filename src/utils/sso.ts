const SSO_BASE_URL = "https://beta.app.ur.network/login-extension";
const SSO_COMPLETE_PATH = "/login-extension/complete";
const SSO_STATE_KEY = "sso_state";
const SSO_STATE_TIMESTAMP_KEY = "sso_state_ts";
const STATE_MAX_AGE_MS = 5 * 60 * 1000;

const EXTENSION_NAME = "URnetwork";
const EXTENSION_VERSION = __EXTENSION_VERSION__;

export function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildSsoUrl(state: string): string {
	const params = new URLSearchParams({
		extension_name: EXTENSION_NAME,
		extension_version: EXTENSION_VERSION,
		state,
	});
	return `${SSO_BASE_URL}?${params.toString()}`;
}

export function isSsoCompleteUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "beta.app.ur.network" &&
			parsed.pathname === SSO_COMPLETE_PATH
		);
	} catch {
		return false;
	}
}

export function parseSsoCompleteUrl(url: string): { code: string; state: string } | null {
	try {
		const parsed = new URL(url);
		const code = parsed.searchParams.get("code");
		const state = parsed.searchParams.get("state");
		if (!code || !state) return null;
		return { code, state };
	} catch {
		return null;
	}
}

export async function storeSsoState(state: string): Promise<void> {
	await chrome.storage.local.set({
		[SSO_STATE_KEY]: state,
		[SSO_STATE_TIMESTAMP_KEY]: Date.now(),
	});
}

export async function retrieveAndValidateState(receivedState: string): Promise<boolean> {
	const result = await chrome.storage.local.get([SSO_STATE_KEY, SSO_STATE_TIMESTAMP_KEY]);
	const storedState = result[SSO_STATE_KEY] as string | undefined;
	const storedTs = result[SSO_STATE_TIMESTAMP_KEY] as number | undefined;

	if (!storedState || storedState !== receivedState) return false;
	if (storedTs && Date.now() - storedTs > STATE_MAX_AGE_MS) return false;

	return true;
}

export async function clearSsoState(): Promise<void> {
	await chrome.storage.local.remove([SSO_STATE_KEY, SSO_STATE_TIMESTAMP_KEY]);
}
