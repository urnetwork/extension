// App content-channel bridge (background side), and the owner of the install's
// one hosted proxy client.
//
// The ur.io app talks to the extension through a content script (content.ts)
// that relays window.postMessage requests over a long-lived Port to this
// service. The extension owns both proxy-session credentials and the actual
// device-rpc websocket. This bridge exposes lifecycle/status verbs; opaque SDK
// rpc frames use the dedicated service in device-rpc.ts. Secrets never cross
// either bridge into the page.
//
// Verbs: PING, GET_STATUS, GET_USER, GET_SESSION, SETUP, REFRESH_JWT, CONNECT,
// DISCONNECT, GET_KILL_SWITCH, SET_KILL_SWITCH, GET_GEO_SYNC,
// SET_PROVIDER_LOCATIONS, SET_LOCATION, SET_PERFORMANCE_PROFILE.
// Events (broadcast to every connected ur.io tab): SESSION_CHANGED,
// USER_CHANGED, GEO_SYNC_CHANGED, APPLY_LOCATION (a popup pick with the time
// it was made, see handleExtensionLocationChange). This control channel
// carries no device-state model; the dedicated device-rpc channel carries
// opaque bytes and the app subscribes to SDK listeners natively. Wire shapes
// live in protocol.ts.
//
// The one hosted proxy client (owner, 2026-11-05: a single client per
// extension). The first connect provisions one hosted proxy client
// (POST /network/auth-client with a proxy config) and saves it (bridge/session.ts);
// every later connect, from the page or the popup, applies it again as the
// browser's one proxy (Chromium fixed_servers, Firefox proxy.onRequest) with
// no auth-client call, a disconnect only takes the proxy off, and nothing
// renews it: the server never expires a hosted proxy (its ProxyClient has no
// expiration). A connect at another location moves the hosted device when a
// ur.io tab can (handleExtensionLocationChange); otherwise it provisions a new
// client there, applies it, and removes the one it replaced before it answers,
// so at most two exist for a moment. Setup and logout remove the client. Every
// client the extension stops using is released through utils/client-release.ts,
// which keeps a failed release for a later pass: a client that is not removed
// stays active on the server until its idle reap (about 30 days after its last
// use), counting against the network's cap of active proxies.
//
// The one exception to "device state does not flow through the bridge" is
// SET_PROVIDER_LOCATIONS, and it is a data-source decision, not a sync
// channel: the geolocation override (content/geo-main.ts) needs the oldest
// connected provider's coordinates, and only the app holds a DeviceRemote —
// the extension owns transport but no Device implementation. The contract is:
//
//   1. on GEO_SYNC_CHANGED {enabled:true} (or a GET_GEO_SYNC answer saying
//      enabled), the app subscribes to
//      addConnectedProviderLocationChangeListener and pushes
//      SET_PROVIDER_LOCATIONS { locations: getConnectedProviderLocations() }
//      — the sdk's list, oldest connected first, pushed as-is;
//   2. it pushes again on every change, and stops on {enabled:false}.
//
// The extension picks the oldest entry that has coordinates and stores it (see
// utils/geo-sync.ts). Pushes are ignored while the toggle is off.
//
// The connect options are provisioning input, like CONNECT's location, not
// device state: the page applies a change to a live device itself, over the
// device-rpc. CONNECT may carry `performanceProfile` (the profile the page
// builds from its settings doc, in the shape its DeviceRemote takes), and
// SET_PERFORMANCE_PROFILE hands over a changed one without reconnecting. The
// extension keeps the last one per network and provisions every new client
// with it (see utils/performance-profile.ts).
import { proxyManager, type ProxyConfig } from "../utils/proxy-manager";
import { chromeStorageAdapter } from "../utils/storage-adapter";
import { BRIDGE_PORT_NAME, type PortRequestFrame } from "./protocol";
import { authNetworkClient, removeNetworkClient } from "./api";
import { buildAuthParams } from "../utils/auth-params";
import { parseJwtClaims } from "../utils/jwt-claims";
import {
	loadBridgeSession,
	saveBridgeSession,
	clearBridgeSession,
	type BridgeSessionRecord,
} from "./session";
import { getKillSwitch } from "../utils/kill-switch";
import { applyKillSwitchSetting } from "../utils/kill-switch-apply";
import { isAllowedOrigin } from "../utils/origins";
import {
	clearGeoSyncPosition,
	getGeoSyncEnabled,
	storeProviderLocations,
} from "../utils/geo-sync";
import { STORAGE_KEY_GEO_ENABLED } from "../content/geo-protocol";
import {
	loadPerformanceProfile,
	parsePerformanceProfile,
	storePerformanceProfile,
} from "../utils/performance-profile";
import type { ConnectLocation, PerformanceProfile } from "../utils/sdk-types";
import {
	addPendingReleaseClients,
	releaseClients,
	removePendingReleaseClients,
} from "../utils/client-release";
import {
	connectLocationKey,
	connectLocationPageId,
	locationIdKey,
} from "../utils/connect-location-key";
import { clearProxyHealth } from "../utils/proxy-health";
import { closeAllDeviceRpcConnections } from "./device-rpc";

// An older version's session renewal alarm. Nothing renews now: an alarm left
// by one is cleared when it fires.
const RENEW_ALARM = "urn-bridge-session-renew";
const STORAGE_KEY_CLIENT_ID = "proxy_client_id";
// An older version's popup pool (several hosted proxies behind a PAC script or
// a Firefox listener), replaced by the one client and released
// (migrateLegacyMultiIp).
const STORAGE_KEY_MULTI_CLIENT_IDS = "multi_ip_client_ids";
const MULTI_IP_SLOTS_KEY = "multi_ip_slots";
// the popup's displayed pick (popup/components/ConnectScreen.tsx), stored as
// JSON by the popup and as an object by persistLocation
const STORAGE_KEY_SELECTED_LOCATION = "selected_connect_location";

export type BridgeUser = {
	networkId: string | null;
	networkName: string | null;
	guestMode: boolean;
} | null;

export type BridgeSessionInfo = {
	connected: boolean;
	mode?: "standard" | "multi-ip";
	instanceId?: string | null;
	clientId?: string | null;
	expirationTime?: string;
	locationId?: string | null;
};

const ports = new Set<chrome.runtime.Port>();

// Serialize connect/disconnect/setup so overlapping requests (multiple tabs,
// the popup) cannot interleave provisioning and teardown.
let opChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = opChain.then(fn, fn);
	opChain = next.catch(() => {});
	return next;
}

async function getJwt(): Promise<string | null> {
	const result = await chrome.storage.local.get("by_jwt");
	return typeof result.by_jwt === "string" && result.by_jwt ? result.by_jwt : null;
}

function jwtNetworkId(jwt: string | null): string | null {
	const networkId = jwt ? parseJwtClaims(jwt)?.network_id : null;
	return typeof networkId === "string" && networkId !== "" ? networkId : null;
}

async function getUser(): Promise<BridgeUser> {
	const result = await chrome.storage.local.get(["by_jwt", "network_name"]);
	const jwt = result.by_jwt;
	if (typeof jwt !== "string" || !jwt) return null;
	const claims = parseJwtClaims(jwt);
	const storedName = typeof result.network_name === "string" ? result.network_name : null;
	return {
		networkId: typeof claims?.network_id === "string" ? claims.network_id : null,
		networkName:
			typeof claims?.network_name === "string" ? claims.network_name : storedName,
		guestMode: Boolean(claims?.guest_mode),
	};
}

// the proxy the browser is given for a saved client
function savedProxyConfig(record: BridgeSessionRecord): ProxyConfig {
	return {
		host: `${record.signedProxyId}.${record.proxyHost}`,
		port: record.httpsProxyPort,
		scheme: "https",
	};
}

function recordLocationKey(record: BridgeSessionRecord): string {
	return record.locationKey ?? locationIdKey(record.locationId);
}

async function getSessionInfo(): Promise<BridgeSessionInfo> {
	const state = await proxyManager.getActualProxyState();
	proxyManager.syncState(state);
	const record = await loadBridgeSession();

	if (state.enabled && state.mode === "fixed" && state.config) {
		// Chrome canonicalizes DNS hostnames to lowercase, while the server's
		// signed proxy id is uppercase base32. Hostname identity is case-insensitive.
		const configuredHost = state.config.host.toLowerCase();
		const recordedHost = record
			? `${record.signedProxyId}.${record.proxyHost}`.toLowerCase()
			: null;
		if (
			record &&
			configuredHost === recordedHost &&
			state.config.port === record.httpsProxyPort
		) {
			return {
				connected: true,
				mode: "standard",
				// An older record may predate apiBaseUrl. Keep the proxy connected but
				// do not advertise an attachable device until a complete session exists.
				instanceId: record.apiBaseUrl ? record.instanceId : null,
				clientId: record.clientId,
				expirationTime: record.expirationTime,
				locationId: record.locationId,
			};
		}

		// Active proxy without a matching record (e.g. session predating the
		// bridge): derive what we can from the proxy host. The first host label
		// is the signed proxy id by construction.
		const host = state.config.host;
		const dot = host.indexOf(".");
		if (0 < dot) {
			return {
				connected: true,
				mode: "standard",
				instanceId: null,
				clientId: await chromeStorageAdapter.getItem(STORAGE_KEY_CLIENT_ID),
			};
		}
		return { connected: true, mode: "standard", instanceId: null };
	}

	if (state.enabled && state.mode === "pac") {
		// an older version's pool, until migrateLegacyMultiIp replaces it
		return { connected: true, mode: "multi-ip" };
	}

	// the proxy is off; the install's client stays saved for the next connect
	return { connected: false };
}

async function storedMultiClientIds(): Promise<string[]> {
	const raw = await chromeStorageAdapter.getItem(STORAGE_KEY_MULTI_CLIENT_IDS);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === "string" && id !== "")
			: [];
	} catch {
		return [];
	}
}

// The clients the browser may be connected through right now: the saved
// client and an older version's pool. A failure pass never releases them.
async function liveClientIds(): Promise<string[]> {
	const clientIds = await storedMultiClientIds();
	const record = await loadBridgeSession();
	if (record?.clientId) clientIds.push(record.clientId);
	const storedClientId = await chromeStorageAdapter.getItem(STORAGE_KEY_CLIENT_ID);
	if (storedClientId) clientIds.push(storedClientId);
	return clientIds;
}

// Releases `clientIds` and every pending client except `liveClientIdList`
// (utils/client-release.ts). With no jwt nothing can be released, so the
// clients are only written down for a later pass.
async function releaseBridgeClients(
	clientIds: string[],
	liveClientIdList: string[],
	jwt: string | null,
): Promise<void> {
	if (!jwt) {
		await addPendingReleaseClients(clientIds.filter((id) => !liveClientIdList.includes(id)));
		return;
	}
	await releaseClients(
		clientIds,
		liveClientIdList,
		async (clientId) => (await removeNetworkClient(clientId, jwt)) !== false,
	);
}

// An older version's pool is over once the one client is applied, or the
// proxy is off: its clients are released and its keys removed.
async function releaseLegacyPool(jwt: string | null, savedClientId: string | null): Promise<void> {
	const legacyClientIds = await storedMultiClientIds();
	await chrome.storage.local.remove(MULTI_IP_SLOTS_KEY);
	if (legacyClientIds.length === 0) return;
	await addPendingReleaseClients(legacyClientIds);
	await chromeStorageAdapter.removeItem(STORAGE_KEY_MULTI_CLIENT_IDS);
	await releaseBridgeClients([], savedClientId ? [savedClientId] : [], jwt);
}

type ConnectOutcome =
	| { ok: true; session: BridgeSessionInfo }
	| { ok: false; error: string; code?: string };

// Connects the browser through the install's one client: the saved client when
// it is this network's and runs at `location`, else a new client at `location`
// that replaces it.
async function connectInternal(location: ConnectLocation | undefined): Promise<ConnectOutcome> {
	const jwt = await getJwt();
	if (!jwt) {
		return {
			ok: false,
			error: "The extension is not set up with a network.",
			code: "not_setup",
		};
	}
	const networkId = jwtNetworkId(jwt);

	const record = await loadBridgeSession();
	if (
		record &&
		(!record.networkId || record.networkId === networkId) &&
		recordLocationKey(record) === connectLocationKey(location)
	) {
		return applySavedClient(record, jwt, networkId);
	}
	return provisionClient(location, jwt, networkId);
}

// The saved client, applied again: nothing is provisioned.
async function applySavedClient(
	record: BridgeSessionRecord,
	jwt: string,
	networkId: string | null,
): Promise<ConnectOutcome> {
	await proxyManager.enable(savedProxyConfig(record));
	if (record.networkId !== networkId || record.locationKey === undefined) {
		await saveBridgeSession({ ...record, networkId, locationKey: recordLocationKey(record) });
	}
	if (record.clientId) {
		await chromeStorageAdapter.setItem(STORAGE_KEY_CLIENT_ID, record.clientId);
	}
	// a connect starts the health count afresh and ends a fallback to direct
	await clearProxyHealth();
	await releaseLegacyPool(jwt, record.clientId);

	const session = await getSessionInfo();
	broadcast("SESSION_CHANGED", { session, reason: "connect" });
	return { ok: true, session };
}

// A new client at `location`, applied, and then the client it replaces
// removed: the first connect, another network's saved client, or a location
// no ur.io tab could move the hosted device to.
async function provisionClient(
	location: ConnectLocation | undefined,
	jwt: string,
	networkId: string | null,
): Promise<ConnectOutcome> {
	const result = await authNetworkClient(
		buildAuthParams(location, await loadPerformanceProfile()),
		jwt,
	);

	const claims = result.by_client_jwt ? parseJwtClaims(result.by_client_jwt) : null;
	const newClientId = typeof claims?.client_id === "string" ? claims.client_id : null;
	if (newClientId) {
		// written down before anything here can fail, and taken off once it is
		// the saved client; a client that does not become it is released, never
		// left active on the server
		await addPendingReleaseClients([newClientId]);
	}
	// what the browser is connected through until the new client replaces it
	const replacedClientIds = (await liveClientIds()).filter((id) => id !== newClientId);
	const releaseNewClient = async () => {
		if (newClientId) {
			await releaseBridgeClients([newClientId], replacedClientIds, jwt);
		}
	};

	if (result.error) {
		const code = result.error.upgrade_required
			? "upgrade_required"
			: result.error.client_limit_exceeded
				? "client_limit"
				: undefined;
		await releaseNewClient();
		return { ok: false, error: result.error.message, code };
	}

	const pr = result.proxy_config_result;
	if (
		!result.by_client_jwt ||
		!pr?.auth_token ||
		!pr.instance_id ||
		!pr.proxy_host ||
		!pr.https_proxy_port ||
		(!pr.api_base_url && !pr.api_port)
	) {
		await releaseNewClient();
		return {
			ok: false,
			error: "Incomplete proxy configuration received",
			code: "incomplete_config",
		};
	}

	try {
		await proxyManager.enable({
			host: `${pr.auth_token}.${pr.proxy_host}`,
			port: pr.https_proxy_port,
			scheme: "https",
		});
	} catch (err) {
		await releaseNewClient();
		throw err;
	}

	const apiBaseUrl =
		pr.api_base_url ??
		(pr.api_port ? `https://api.${pr.proxy_host}:${pr.api_port}` : null);

	const record: BridgeSessionRecord = {
		clientId: newClientId,
		instanceId: pr.instance_id,
		signedProxyId: pr.auth_token,
		proxyHost: pr.proxy_host,
		httpsProxyPort: pr.https_proxy_port,
		apiBaseUrl,
		expirationTime: pr.expiration_time,
		locationId: connectLocationPageId(location),
		locationKey: connectLocationKey(location),
		networkId,
	};
	await saveBridgeSession(record);
	// Close the prior authenticated socket only after its replacement session is
	// durable, so DeviceRemote reconnects against the new extension-owned data.
	closeAllDeviceRpcConnections("device session changed");
	if (newClientId) {
		await chromeStorageAdapter.setItem(STORAGE_KEY_CLIENT_ID, newClientId);
		await removePendingReleaseClients([newClientId]);
	}
	await clearProxyHealth();
	// The client this one replaced, and an older version's pool, are over:
	// removed before this answers, so the network holds two clients only for
	// this moment. A failed release stays pending for a later pass.
	if (0 < replacedClientIds.length) {
		await addPendingReleaseClients(replacedClientIds);
		await chromeStorageAdapter.removeItem(STORAGE_KEY_MULTI_CLIENT_IDS);
		await chrome.storage.local.remove(MULTI_IP_SLOTS_KEY);
	}
	await releaseBridgeClients([], newClientId ? [newClientId] : [], jwt);

	const session = await getSessionInfo();
	broadcast("SESSION_CHANGED", { session, reason: "connect" });
	return { ok: true, session };
}

// Takes the proxy off. The install's client stays saved for the next connect.
async function disconnectInternal(
	reason: string = "disconnect",
	jwtOverride?: string | null,
): Promise<BridgeSessionInfo> {
	closeAllDeviceRpcConnections("device session disconnected");
	await chrome.alarms.clear(RENEW_ALARM);
	const jwt = jwtOverride !== undefined ? jwtOverride : await getJwt();

	try {
		await proxyManager.disable();
	} catch {
		// keep tearing down
	}
	await clearProxyHealth();
	await releaseLegacyPool(jwt, (await loadBridgeSession())?.clientId ?? null);
	// no connection, no provider: the geolocation override stops reporting a
	// location that nothing is exiting through any more (the toggle itself is
	// left as the user set it)
	await clearGeoSyncPosition();

	const session = await getSessionInfo();
	broadcast("SESSION_CHANGED", { session, reason });
	return session;
}

// Takes the proxy off and removes the install's client: the extension's
// identity is changing (setup) or ending (logout), and the client belongs to
// the network it leaves.
async function endInternal(reason: string, jwtOverride?: string | null): Promise<BridgeSessionInfo> {
	const jwt = jwtOverride !== undefined ? jwtOverride : await getJwt();
	const record = await loadBridgeSession();
	const storedClientId = await chromeStorageAdapter.getItem(STORAGE_KEY_CLIENT_ID);
	// written down before the record goes, so a release that fails, or a worker
	// that stops midway, leaves the client to a later pass
	await addPendingReleaseClients(
		[record?.clientId, storedClientId].filter((id): id is string => Boolean(id)),
	);
	await clearBridgeSession();
	await chromeStorageAdapter.removeItem(STORAGE_KEY_CLIENT_ID);

	const session = await disconnectInternal(reason, jwt);
	await releaseBridgeClients([], [], jwt);
	return session;
}

async function setupInternal(jwt: string, networkName?: string): Promise<{ user: BridgeUser }> {
	const claims = parseJwtClaims(jwt);
	if (!claims) {
		throw new Error("Invalid token");
	}
	if (claims.guest_mode) {
		// the web app has no guest entry point by design; reject defensively
		throw new Error("Guest sessions cannot set up the extension.");
	}

	// tear down any existing session under the OLD identity before replacing it
	const oldJwt = await getJwt();
	await endInternal("setup", oldJwt);

	const storageData: Record<string, string> = { by_jwt: jwt };
	const name =
		networkName ?? (typeof claims.network_name === "string" ? claims.network_name : undefined);
	if (name) {
		storageData.network_name = name;
	}
	await chrome.storage.local.set(storageData);

	// keep the popup in sync (same signal the SET_JWT external path sends)
	chrome.runtime
		.sendMessage({ type: "JWT_RECEIVED", jwt, networkName: name })
		.catch(() => {});

	const user = await getUser();
	broadcast("USER_CHANGED", { user });
	return { user };
}

// In-place jwt swap for the SAME network identity — the non-disruptive
// counterpart to SETUP. After a payment/upgrade the app holds a fresh jwt with
// a new entitlement claim; the extension only needs to start using it. Nothing
// here requires a reconnect: the live proxy authenticates with the signed
// proxy id (not the jwt), and every jwt consumer — connectInternal, the
// releases, the popup's api calls — reads `by_jwt` from storage at call time.
// So swapping storage makes api calls and the next provision use the new jwt
// immediately while the proxy session keeps running untouched.
//
// Statuses (returned as data, not thrown, so the page can branch):
//   refreshed     — jwt swapped in place
//   no_session    — extension has no stored identity; nothing to refresh
//   wrong_network — jwt belongs to a different network than the stored one;
//                   that is an account switch, which must go through SETUP's
//                   atomic teardown, so the page falls back to it
async function refreshJwtInternal(
	jwt: string,
): Promise<{ status: "refreshed" | "no_session" | "wrong_network"; user?: BridgeUser }> {
	const claims = parseJwtClaims(jwt);
	if (!claims) {
		throw new Error("Invalid token");
	}
	if (claims.guest_mode) {
		// same defensive stance as SETUP
		throw new Error("Guest sessions cannot refresh the extension.");
	}

	const oldJwt = await getJwt();
	if (!oldJwt) {
		return { status: "no_session" };
	}
	const oldClaims = parseJwtClaims(oldJwt);
	if (
		typeof claims.network_id !== "string" ||
		!claims.network_id ||
		oldClaims?.network_id !== claims.network_id
	) {
		return { status: "wrong_network" };
	}

	const storageData: Record<string, string> = { by_jwt: jwt };
	const name = typeof claims.network_name === "string" ? claims.network_name : undefined;
	if (name) {
		storageData.network_name = name;
	}
	await chrome.storage.local.set(storageData);

	// keep the popup in sync (same signal SETUP and the external SET_JWT send);
	// app tabs get USER_CHANGED from the storage.onChanged listener
	chrome.runtime
		.sendMessage({ type: "JWT_RECEIVED", jwt, networkName: name })
		.catch(() => {});

	return { status: "refreshed", user: await getUser() };
}

function pageLocation(locationId: string | null): ConnectLocation | undefined {
	return locationId
		? ({ connect_location_id: { location_id: locationId } } as ConnectLocation)
		: undefined;
}

async function storedPopupLocation(): Promise<ConnectLocation | undefined> {
	const result = await chrome.storage.local.get(STORAGE_KEY_SELECTED_LOCATION);
	const value: unknown = result[STORAGE_KEY_SELECTED_LOCATION];
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as ConnectLocation;
		} catch {
			return undefined;
		}
	}
	return value && typeof value === "object" ? (value as ConnectLocation) : undefined;
}

async function handleVerb(
	verb: string,
	payload: Record<string, unknown> | undefined,
): Promise<unknown> {
	switch (verb) {
		case "PING": {
			return { version: chrome.runtime.getManifest().version };
		}
		case "GET_STATUS": {
			const [user, session, killSwitch] = await Promise.all([
				getUser(),
				getSessionInfo(),
				getKillSwitch(),
			]);
			return {
				version: chrome.runtime.getManifest().version,
				user,
				session,
				killSwitch,
			};
		}
		case "GET_USER": {
			return { user: await getUser() };
		}
		case "GET_SESSION": {
			return { session: await getSessionInfo() };
		}
		case "SETUP": {
			const jwt = payload?.jwt;
			if (typeof jwt !== "string" || !jwt) {
				throw new Error("Missing jwt");
			}
			const networkName =
				typeof payload?.networkName === "string" ? payload.networkName : undefined;
			return await serialize(() => setupInternal(jwt, networkName));
		}
		case "REFRESH_JWT": {
			const jwt = payload?.byJwt;
			if (typeof jwt !== "string" || !jwt) {
				throw new Error("Missing byJwt");
			}
			// serialized so a refresh cannot interleave with a SETUP/DISCONNECT
			// that is swapping the stored identity underneath it
			return await serialize(() => refreshJwtInternal(jwt));
		}
		case "CONNECT": {
			const locationId = typeof payload?.locationId === "string" ? payload.locationId : null;
			// an older page sends no connect options: provision with the kept ones
			const performanceProfile = payloadPerformanceProfile(payload);
			const outcome = await serialize(async () => {
				if (performanceProfile !== undefined) {
					await storePerformanceProfile(performanceProfile);
				}
				return connectInternal(pageLocation(locationId));
			});
			if (!outcome.ok) {
				const err = new Error(outcome.error) as Error & { code?: string };
				err.code = outcome.code;
				throw err;
			}
			return { session: outcome.session };
		}
		case "DISCONNECT": {
			return { session: await serialize(() => disconnectInternal()) };
		}
		case "GET_KILL_SWITCH": {
			return { enabled: await getKillSwitch() };
		}
		case "SET_KILL_SWITCH": {
			const enabled = Boolean(payload?.enabled);
			await applyKillSwitchSetting(enabled);
			return { enabled };
		}
		case "GET_GEO_SYNC": {
			// the app asks on connect whether it should be pushing provider
			// locations for the geolocation override
			return { enabled: await getGeoSyncEnabled() };
		}
		case "SET_PROVIDER_LOCATIONS": {
			const position = await storeProviderLocations(payload?.locations);
			return { applied: position !== null };
		}
		case "SET_LOCATION": {
			// The app changed the connect location. The hosted device was already
			// re-routed by the app over the device-rpc (no proxy reconnect), so the
			// extension only needs to reflect it — UNLESS it isn't connected, in
			// which case a location change means "connect here."
			const locationId = typeof payload?.locationId === "string" ? payload.locationId : null;
			const name = typeof payload?.name === "string" ? payload.name : undefined;
			const session = await getSessionInfo();
			if (!session.connected) {
				const outcome = await serialize(() => connectInternal(pageLocation(locationId)));
				if (!outcome.ok) {
					const err = new Error(outcome.error) as Error & { code?: string };
					err.code = outcome.code;
					throw err;
				}
				return { session: outcome.session, applied: "connected" };
			}
			// connected: update the stored/displayed location only — do NOT
			// re-provision (that would reconnect the proxy)
			await persistLocation(locationId, name);
			return { session: await getSessionInfo(), applied: "display" };
		}
		case "SET_PERFORMANCE_PROFILE": {
			// The page's connect options changed (or it just linked): keep them
			// for the next client this extension provisions. A live device
			// already got the change from the page over the device-rpc, so nothing
			// reconnects. Serialized so a CONNECT or SET_LOCATION sent after it
			// provisions with it.
			const performanceProfile = parsePerformanceProfile(payload?.performanceProfile);
			return { stored: await serialize(() => storePerformanceProfile(performanceProfile)) };
		}
		default: {
			throw new Error(`Unknown verb: ${verb}`);
		}
	}
}

// The connect options a request carries: undefined when it carries none (an
// older page), else the wire profile. Throws on an invalid one before the
// request changes anything.
function payloadPerformanceProfile(
	payload: Record<string, unknown> | undefined,
): PerformanceProfile | null | undefined {
	return payload?.performanceProfile === undefined
		? undefined
		: parsePerformanceProfile(payload.performanceProfile);
}

// Persist the current location so the popup and the saved client stay in
// sync, without touching the proxy connection: the hosted device runs at it
// now (an app moved it over the device-rpc). `selected_connect_location` is
// the popup's own display key (see ConnectScreen).
async function persistLocation(locationId: string | null, name?: string): Promise<void> {
	const record = await loadBridgeSession();
	if (record) {
		await saveBridgeSession({ ...record, locationId, locationKey: locationIdKey(locationId) });
	}
	if (locationId) {
		await chrome.storage.local.set({
			selected_connect_location: {
				connect_location_id: { location_id: locationId },
				...(name ? { name } : {}),
			},
		});
	} else {
		await chrome.storage.local.remove("selected_connect_location");
	}
	// nudge the popup (if open) to re-read its displayed location
	chrome.runtime.sendMessage({ type: "LOCATION_UPDATED", locationId, name }).catch(() => {});
}

// Whether any ur.io app tab is attached to the bridge (so it holds a live
// DeviceRemote that can change the hosted device's location over the device-rpc
// without a proxy reconnect).
export function hasConnectedApp(): boolean {
	return ports.size > 0;
}

// Scenario 1: the user changed location in the EXTENSION. If an app is attached,
// delegate the change to its DeviceRemote (device-rpc → the hosted device
// re-routes and every attached remote gets connectLocationChange — no proxy
// reconnect and no new client). Returns delegated=true when the app will apply
// it; delegated=false tells the caller (popup) to connect at the location the
// normal way, which replaces the install's client.
// The pick carries the time it was made (pickedAt, epoch ms): every ur.io tab
// records it as the page's newest location choice, and a tab that runs it late
// (a frozen background tab) must not let it replace a choice made after it.
// Only a session a page can attach a device to is delegated, the session the
// page's hostedDeviceSessionKey accepts (standard, with a hosted instance): a
// session without an instance has no device for a page to move.
export async function handleExtensionLocationChange(
	locationId: string | null,
	name?: string,
): Promise<{ delegated: boolean }> {
	const pickedAt = Date.now();
	const session = await getSessionInfo();
	if (
		!session.connected ||
		session.mode !== "standard" ||
		!session.instanceId ||
		ports.size === 0
	) {
		return { delegated: false };
	}
	await persistLocation(locationId, name);
	broadcast("APPLY_LOCATION", { locationId, name: name ?? null, pickedAt });
	return { delegated: true };
}

// The popup's requests (utils/connection-manager.ts, through background/index.ts):
// the same serialized operations the page's verbs run.
export function connectFromPopup(location: ConnectLocation | undefined): Promise<ConnectOutcome> {
	return serialize(() => connectInternal(location));
}

export function disconnectFromPopup(): Promise<BridgeSessionInfo> {
	return serialize(() => disconnectInternal());
}

// logout: the client goes with the identity
export function endFromPopup(): Promise<BridgeSessionInfo> {
	return serialize(() => endInternal("logout"));
}

export function sessionForPopup(): Promise<BridgeSessionInfo> {
	return getSessionInfo();
}

// An older version kept a pool of hosted proxies behind a PAC script
// (Chromium) or a listener (Firefox). On upgrade a connected pool is replaced
// by the install's one client at the popup's last pick, and every pool client
// is released. A failed connect leaves the pool as it is, for the next start.
export async function migrateLegacyMultiIp(): Promise<void> {
	const legacyClientIds = await storedMultiClientIds();
	const stored = await chrome.storage.local.get(["proxy_enabled", MULTI_IP_SLOTS_KEY]);
	const state = await proxyManager.getActualProxyState();
	const poolConnected =
		state.mode === "pac" ||
		(Boolean(stored.proxy_enabled) && typeof stored[MULTI_IP_SLOTS_KEY] === "string");
	if (legacyClientIds.length === 0 && !poolConnected) return;

	await serialize(async () => {
		if (poolConnected) {
			await connectInternal(await storedPopupLocation());
			return;
		}
		await releaseLegacyPool(await getJwt(), (await loadBridgeSession())?.clientId ?? null);
	});
}

function broadcast(event: string, payload: unknown): void {
	for (const port of ports) {
		try {
			port.postMessage({ dir: "event", event, payload });
		} catch {
			ports.delete(port);
		}
	}
}

// Recompute the session snapshot and broadcast it. Called from the popup
// message handlers and the health check so app tabs stay current no matter
// which surface acted. Debounced: several handlers can fire in quick succession.
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
export function notifySessionChanged(reason: string = "changed"): void {
	closeAllDeviceRpcConnections(`device session ${reason}`);
	if (notifyTimer !== null) {
		clearTimeout(notifyTimer);
	}
	notifyTimer = setTimeout(() => {
		notifyTimer = null;
		getSessionInfo()
			.then((session) => broadcast("SESSION_CHANGED", { session, reason }))
			.catch(() => {});
	}, 150);
}

export function initBridge(): void {
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== BRIDGE_PORT_NAME) return;
		if (!isAllowedOrigin(port.sender?.url)) {
			try {
				port.disconnect();
			} catch {
				// ignore
			}
			return;
		}

		ports.add(port);
		port.onDisconnect.addListener(() => {
			ports.delete(port);
		});
		port.onMessage.addListener((msg: PortRequestFrame) => {
			if (!msg || msg.id == null || typeof msg.verb !== "string") return;
			handleVerb(msg.verb, msg.payload as Record<string, unknown> | undefined)
				.then((data) => {
					try {
						port.postMessage({ dir: "res", id: msg.id, ok: true, data });
					} catch {
						// port gone
					}
				})
				.catch((err: Error & { code?: string }) => {
					try {
						port.postMessage({
							dir: "res",
							id: msg.id,
							ok: false,
							error: err?.message ?? "error",
							code: err?.code,
						});
					} catch {
						// port gone
					}
				});
		});
	});

	chrome.alarms.onAlarm.addListener((alarm) => {
		if (alarm.name === RENEW_ALARM) {
			// an older version's renewal: nothing to renew, and no new client
			chrome.alarms.clear(RENEW_ALARM).catch(() => {});
		}
	});

	// USER_CHANGED for every identity change, whichever surface caused it
	// (popup login, external SET_JWT, bridge SETUP)
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.by_jwt || changes.network_name) {
			getUser()
				.then((user) => broadcast("USER_CHANGED", { user }))
				.catch(() => {});
		}
		// the popup owns the geolocation override toggle; app tabs learn about it
		// here so they can start or stop pushing provider locations
		if (changes[STORAGE_KEY_GEO_ENABLED]) {
			broadcast("GEO_SYNC_CHANGED", {
				enabled: changes[STORAGE_KEY_GEO_ENABLED].newValue === true,
			});
		}
	});
}
