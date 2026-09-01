// App content-channel bridge (background side).
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
// SET_PROVIDER_LOCATIONS, SET_LOCATION.
// Events (broadcast to every connected ur.io tab): SESSION_CHANGED,
// USER_CHANGED, GEO_SYNC_CHANGED. This control channel carries no device-state
// model; the dedicated device-rpc channel carries opaque bytes and the app
// subscribes to SDK listeners natively. Wire shapes live in protocol.ts.
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
import { proxyManager } from "../utils/proxy-manager";
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
import type { ConnectLocation } from "node_modules/@urnetwork/sdk-js/dist/generated";
import { closeAllDeviceRpcConnections } from "./device-rpc";

const RENEW_ALARM = "urn-bridge-session-renew";
const RENEW_RETRY_MS = 60_000;
// keys shared with the popup connection manager (see connection-manager.ts)
const STORAGE_KEY_CLIENT_ID = "proxy_client_id";
const STORAGE_KEY_MULTI_CLIENT_IDS = "multi_ip_client_ids";
const MULTI_IP_SLOTS_KEY = "multi_ip_slots";

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
// renewal alarm) cannot interleave provisioning and teardown.
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
		// multi-IP/PAC (popup-provisioned) — no single device-rpc session
		return { connected: true, mode: "multi-ip" };
	}

	// reconcile: proxy is off, so any lingering record/alarm is stale
	if (record) {
		await clearBridgeSession();
		await chrome.alarms.clear(RENEW_ALARM);
	}
	return { connected: false };
}

async function releaseClient(
	clientId: string | null | undefined,
	jwt: string | null,
): Promise<void> {
	if (clientId && jwt) {
		try {
			await removeNetworkClient(clientId, jwt);
		} catch {
			// best effort
		}
	}
}

type ConnectOutcome =
	| { ok: true; session: BridgeSessionInfo }
	| { ok: false; error: string; code?: string };

async function connectInternal(
	locationId: string | null,
	reason: "connect" | "renew" = "connect",
): Promise<ConnectOutcome> {
	const jwt = await getJwt();
	if (!jwt) {
		return {
			ok: false,
			error: "The extension is not set up with a network.",
			code: "not_setup",
		};
	}

	const location = locationId
		? ({ connect_location_id: { location_id: locationId } } as ConnectLocation)
		: undefined;
	const result = await authNetworkClient(buildAuthParams(location), jwt);

	if (result.error) {
		const code = result.error.upgrade_required
			? "upgrade_required"
			: result.error.client_limit_exceeded
				? "client_limit"
				: undefined;
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
		return {
			ok: false,
			error: "Incomplete proxy configuration received",
			code: "incomplete_config",
		};
	}

	await proxyManager.enable({
		host: `${pr.auth_token}.${pr.proxy_host}`,
		port: pr.https_proxy_port,
		scheme: "https",
	});

	const claims = parseJwtClaims(result.by_client_jwt);
	const newClientId = typeof claims?.client_id === "string" ? claims.client_id : null;

	const prior = await loadBridgeSession();
	if (prior?.clientId && prior.clientId !== newClientId) {
		// release the replaced client (best effort, no await)
		releaseClient(prior.clientId, jwt);
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
		locationId,
	};
	await saveBridgeSession(record);
	// Close the prior authenticated socket only after its replacement session is
	// durable, so DeviceRemote reconnects against the new extension-owned data.
	closeAllDeviceRpcConnections("device session changed");
	if (newClientId) {
		await chromeStorageAdapter.setItem(STORAGE_KEY_CLIENT_ID, newClientId);
	}

	// proactive credential renewal at 80% of the session lifetime — this runs in
	// the background so bridge sessions renew even with no popup and no app tab
	if (pr.expiration_time) {
		const expiresAt = new Date(pr.expiration_time).getTime();
		const lifetime = expiresAt - Date.now();
		if (lifetime > 0) {
			chrome.alarms.create(RENEW_ALARM, { when: Date.now() + Math.floor(lifetime * 0.8) });
		}
	}

	const session = await getSessionInfo();
	broadcast("SESSION_CHANGED", { session, reason });
	return { ok: true, session };
}

async function disconnectInternal(
	jwtOverride?: string | null,
	reason: string = "disconnect",
): Promise<BridgeSessionInfo> {
	closeAllDeviceRpcConnections("device session disconnected");
	const jwt = jwtOverride !== undefined ? jwtOverride : await getJwt();
	await chrome.alarms.clear(RENEW_ALARM);

	const state = await proxyManager.getActualProxyState();
	const record = await loadBridgeSession();

	try {
		await proxyManager.disable();
	} catch {
		// keep tearing down
	}

	if (state.enabled && state.mode === "pac") {
		// popup-provisioned multi-IP teardown: release every slot client
		try {
			proxyManager.disableMultiIp();
		} catch {
			// chromium PAC: disable() above already set direct
		}
		const raw = await chromeStorageAdapter.getItem(STORAGE_KEY_MULTI_CLIENT_IDS);
		if (raw) {
			try {
				const ids = JSON.parse(raw) as string[];
				await Promise.allSettled(ids.map((id) => releaseClient(id, jwt)));
			} catch {
				// ignore
			}
		}
		await chromeStorageAdapter.removeItem(STORAGE_KEY_MULTI_CLIENT_IDS);
		await chrome.storage.local.remove(MULTI_IP_SLOTS_KEY);
	}

	const clientId =
		record?.clientId ?? (await chromeStorageAdapter.getItem(STORAGE_KEY_CLIENT_ID));
	await releaseClient(clientId, jwt);
	await clearBridgeSession();
	await chromeStorageAdapter.removeItem(STORAGE_KEY_CLIENT_ID);
	// no connection, no provider: the geolocation override stops reporting a
	// location that nothing is exiting through any more (the toggle itself is
	// left as the user set it)
	await clearGeoSyncPosition();

	const session = await getSessionInfo();
	broadcast("SESSION_CHANGED", { session, reason });
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
	await disconnectInternal(oldJwt, "setup");

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
// renewal alarm, releaseClient, the popup's api calls — reads `by_jwt` from
// storage at call time. So swapping storage makes api calls and the next
// provision/renewal use the new jwt immediately while the proxy session keeps
// running untouched.
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

async function renewSession(): Promise<void> {
	const record = await loadBridgeSession();
	if (!record) return;

	const outcome = await serialize(() => connectInternal(record.locationId ?? null, "renew"));
	if (!outcome.ok) {
		const expiresAt = record.expirationTime ? new Date(record.expirationTime).getTime() : 0;
		if (Date.now() + RENEW_RETRY_MS < expiresAt) {
			chrome.alarms.create(RENEW_ALARM, { when: Date.now() + RENEW_RETRY_MS });
		} else {
			await serialize(() => disconnectInternal(undefined, "expired"));
		}
	}
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
			const outcome = await serialize(() => connectInternal(locationId));
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
				const outcome = await serialize(() => connectInternal(locationId));
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
		default: {
			throw new Error(`Unknown verb: ${verb}`);
		}
	}
}

// Persist the current location so the popup and the renewal path stay in sync,
// without touching the proxy connection. `selected_connect_location` is the
// popup's own display key (see ConnectScreen).
async function persistLocation(locationId: string | null, name?: string): Promise<void> {
	const record = await loadBridgeSession();
	if (record) {
		await saveBridgeSession({ ...record, locationId });
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
// reconnect). Returns delegated=true when the app will apply it; delegated=false
// tells the caller (popup) to change location the normal way (connect / swap).
export async function handleExtensionLocationChange(
	locationId: string | null,
	name?: string,
): Promise<{ delegated: boolean }> {
	const session = await getSessionInfo();
	if (!session.connected || ports.size === 0) {
		return { delegated: false };
	}
	await persistLocation(locationId, name);
	broadcast("APPLY_LOCATION", { locationId, name: name ?? null });
	return { delegated: true };
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
// message handlers so app tabs stay current no matter which surface acted.
// Debounced: several handlers can fire in quick succession.
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
			renewSession().catch((err) => {
				console.error("Bridge session renewal failed:", err);
			});
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
