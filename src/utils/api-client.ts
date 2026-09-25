// The generated URnetwork api client (@urnetwork/sdk/client: every operation
// of the OpenAPI spec, wasm-free and DOM-free) for the code that runs outside
// the popup's React tree — the MV3 service worker (background/, bridge/).
// The popup uses the same client through useAPI().client.
import { createURNetworkApiClient, type URNetworkApiClient } from "@urnetwork/sdk/client";

export const API_TIMEOUT_MS = 15_000;

let client: URNetworkApiClient | null = null;

/**
 * The shared client. Bearer operations authenticate with the stored network
 * JWT (`by_jwt`), read per request so a refreshed or cleared token is picked up;
 * callers holding a specific JWT pass it per call as `{ token }`.
 */
export function extensionApiClient(): URNetworkApiClient {
	if (!client) {
		client = createURNetworkApiClient({
			token: async () => {
				const { by_jwt } = await chrome.storage.local.get("by_jwt");
				return typeof by_jwt === "string" && by_jwt ? by_jwt : null;
			},
			timeoutMs: API_TIMEOUT_MS,
		});
	}
	return client;
}
