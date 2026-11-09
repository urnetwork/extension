// The install's one hosted proxy client (owner, 2026-11-05: a single client
// per extension). Provisioned on the first connect and kept: every later
// connect, reconnect, reattach and service worker restart applies it again
// with no auth-client call, and a disconnect only takes the proxy off. It is
// replaced by a location change with no ur.io tab to move the hosted device,
// or when the server no longer has it after the health check gave up on it,
// and removed when the extension's identity changes (setup, logout).
// Device-rpc endpoint and credential fields are extension-private and must
// never be returned to the ur.io page.
export type BridgeSessionRecord = {
	clientId: string | null;
	instanceId: string;
	signedProxyId: string;
	proxyHost: string;
	httpsProxyPort: number;
	// https://api.<proxyHost>:<apiPort> — the device-rpc endpoint base
	apiBaseUrl: string | null;
	expirationTime?: string;
	// the page's location id (connect_location_id.location_id), null for best
	// available; kept for the page and the popup's display
	locationId?: string | null;
	// the connect location the hosted device runs at, as a key
	// (utils/connect-location-key.ts); a record without one predates it and is
	// keyed by its locationId
	locationKey?: string;
	// the network the client belongs to; a record without one predates it and
	// belongs to the stored identity (setup and logout remove the record)
	networkId?: string | null;
};

const BRIDGE_SESSION_KEY = "bridge_session";

export async function saveBridgeSession(record: BridgeSessionRecord): Promise<void> {
	await chrome.storage.local.set({ [BRIDGE_SESSION_KEY]: record });
}

export async function loadBridgeSession(): Promise<BridgeSessionRecord | null> {
	const result = await chrome.storage.local.get(BRIDGE_SESSION_KEY);
	const value = result[BRIDGE_SESSION_KEY];
	if (value && typeof value === "object") {
		return value as BridgeSessionRecord;
	}
	return null;
}

export async function clearBridgeSession(): Promise<void> {
	await chrome.storage.local.remove(BRIDGE_SESSION_KEY);
}
