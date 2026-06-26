declare const browser: typeof chrome | undefined;

const SSO_BASE_URL = "https://beta.app.ur.network/login-extension";
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

interface WebAuthFlowOptions {
	url: string;
	interactive?: boolean;
}

type IdentityApi = {
	getRedirectURL(path?: string): string;
	launchWebAuthFlow(
		options: WebAuthFlowOptions,
		callback?: (responseUrl?: string) => void,
	): void;
};

/**
 * Returns the identity API namespace. Firefox uses a Promise-based `browser`
 * object; Chrome uses callback-based `chrome`.
 */
function getIdentityApi(): IdentityApi {
	if (typeof browser !== "undefined" && (browser as typeof chrome).identity) {
		return (browser as typeof chrome).identity as IdentityApi;
	}
	return chrome.identity;
}

/**
 * Promisified chrome.identity.launchWebAuthFlow that works on Chrome and
 * Firefox.
 */
function launchWebAuthFlow(options: WebAuthFlowOptions): Promise<string | undefined> {
	const identity = getIdentityApi();
	return new Promise((resolve, reject) => {
		identity.launchWebAuthFlow(options, (responseUrl) => {
			const err =
				chrome.runtime?.lastError?.message ||
				(typeof browser !== "undefined" && (browser as any).runtime?.lastError?.message);
			if (err) {
				reject(new Error(err));
				return;
			}
			resolve(responseUrl);
		});
	});
}

/**
 * Starts the browser-managed OAuth flow.
 *
 * The website will redirect the auth code to the extension's private
 * identity redirect URL (e.g. https://<id>.chromiumapp.org/...), which only
 * this extension can receive.
 */
export async function startSsoFlow(): Promise<{ code: string; state: string } | null> {
	const state = generateState();
	await storeSsoState(state);

	const redirectUrl = chrome.identity.getRedirectURL("sso-complete");
	const params = new URLSearchParams({
		extension_name: EXTENSION_NAME,
		extension_version: EXTENSION_VERSION,
		state,
		redirect_uri: redirectUrl,
	});

	// Include the extension ID only when it looks like a stable browser-store ID.
	const extensionId = chrome.runtime.id;
	if (extensionId && extensionId.length >= 20) {
		params.set("extension_id", extensionId);
	}

	const authUrl = `${SSO_BASE_URL}?${params.toString()}`;

	try {
		const resultUrl = await launchWebAuthFlow({
			url: authUrl,
			interactive: true,
		});

		if (!resultUrl) {
			await clearSsoState();
			return null;
		}

		return parseSsoCompleteUrl(resultUrl, state);
	} catch (err) {
		console.error("SSO flow failed:", err);
		await clearSsoState();
		return null;
	}
}

/**
 * Parse the browser identity redirect URL for the auth code and state.
 * Validates the state against local storage and clears it afterwards.
 */
export async function parseSsoCompleteUrl(
	url: string,
	expectedState: string,
): Promise<{ code: string; state: string } | null> {
	try {
		const parsed = new URL(url);
		const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
		const hashParams = new URLSearchParams(hash);
		const code = hashParams.get("code");
		const state = hashParams.get("state");

		if (!code || !state || state !== expectedState) {
			return null;
		}

		const valid = await retrieveAndValidateState(state);
		if (!valid) {
			return null;
		}

		return { code, state };
	} catch {
		return null;
	}
}

export async function getSsoCode(): Promise<string | null> {
	const result = await chrome.storage.local.get("sso_code");
	return (result["sso_code"] as string | undefined) ?? null;
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

	const isMissing = !storedState;
	const isMismatch = storedState !== receivedState;
	const isExpired = storedTs ? Date.now() - storedTs > STATE_MAX_AGE_MS : true;

	if (isMissing || isMismatch || isExpired) {
		await clearSsoState();
		return false;
	}

	await clearSsoState();
	return true;
}

export async function clearSsoState(): Promise<void> {
	await chrome.storage.local.remove([SSO_STATE_KEY, SSO_STATE_TIMESTAMP_KEY]);
}
