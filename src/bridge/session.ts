// The bridge session record is the extension's durable snapshot of the active
// standard-mode proxy session. Device-rpc endpoint and credential fields are
// extension-private and must never be returned to the ur.io page. Written on
// every successful standard-mode bridge provision and cleared on teardown.
export type BridgeSessionRecord = {
	clientId: string | null;
	instanceId: string;
	signedProxyId: string;
	proxyHost: string;
	httpsProxyPort: number;
	// https://api.<proxyHost>:<apiPort> — the device-rpc endpoint base
	apiBaseUrl: string | null;
	expirationTime?: string;
	locationId?: string | null;
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
