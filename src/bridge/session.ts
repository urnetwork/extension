// The bridge session record is the extension's durable snapshot of the active
// standard-mode proxy session. It is what the ur.io app needs to attach a
// DeviceRemote to the hosted device: the signed proxy id (= auth_token, the
// device-rpc credential) and the proxy api base url (the device-rpc endpoint,
// wss://api.<proxyHost>:<apiPort>/device-rpc). Written on every successful
// provision (popup or bridge initiated), cleared on teardown.
export type BridgeSessionRecord = {
	clientId: string | null;
	signedProxyId: string;
	proxyHost: string;
	httpsProxyPort?: number;
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
