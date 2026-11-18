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
// Verbs: PING, GET_STATUS, GET_USER, GET_SESSION, SETUP, RENEW_SESSION,
// REFRESH_JWT, CONNECT, DISCONNECT, GET_KILL_SWITCH, SET_KILL_SWITCH,
// GET_GEO_SYNC, SET_PROVIDER_LOCATIONS, SET_LOCATION, SET_PERFORMANCE_PROFILE.
// Events (broadcast to every connected ur.io tab): SESSION_CHANGED,
// USER_CHANGED, GEO_SYNC_CHANGED, APPLY_LOCATION (a popup pick with the time
// it was made, see handleExtensionLocationChange). This control channel
// carries no device-state model; the dedicated device-rpc channel carries
// opaque bytes and the app subscribes to SDK listeners natively. Wire shapes
// live in protocol.ts.
//
// The extension's own sign-in (owner decision 2026-11-18, utils/own-sign-in.ts):
// the extension signs in with a session of its own, which the account's
// Sessions list shows apart and a sign-out on ur.io leaves signed in. PING
// answers what this version's bridge does (protocol.ts BRIDGE_CAPABILITIES:
// setupAuthCode, renewSession), and the page keys off it.
//   SETUP {authCode, networkId, networkName} — a one-use sign-in code the page
//     created with its own sign-in. The extension redeems it (one request id;
//     the same code and id sent once more only when the answer was lost) and
//     checks the sign-in (not a guest's, of networkId when given) before
//     anything changes; only then is the old identity torn down and the new
//     one stored. A failure leaves the old identity as it was and throws a
//     code the page branches on: auth_code_refused, session_limit_reached or
//     wrong_network. An older page's SETUP {jwt} still hands over the page's
//     own token, which shares the page's session.
//   RENEW_SESSION — renews the extension's own token now and answers {status:
//     renewed | no_session | signed_out}. signed_out: the server rejected the
//     renewal (the sign-in was revoked in Sessions, or expired), and the
//     extension signed out locally, as its popup's sign-out does.
//   REFRESH_JWT {byJwt} — an older page's push after a payment. The page's
//     token is never adopted: the extension renews its own instead and
//     answers refreshed (no_session and wrong_network as before), so the page
//     does not fall back to SETUP {jwt}.
// The extension renews its token itself on an alarm (OWN_SESSION_RENEW_ALARM)
// at networkTokenRenewalTime of the token, set whenever by_jwt changes and at
// service worker start; a renewal that did not come back is tried again after
// renewRetryMs. An install from before, which holds ur.io's token, moves to a
// session of its own by itself (migrateToOwnSignIn), and leaves ur.io's alone. Its popup's sign-out, and a setup that replaces its sign-in,
// sign its own session out on the server before its token is forgotten, best
// effort and bounded, so a signed-out extension does not stay listed as a live
// session.
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
// so at most two exist for a moment. When the network's proxy cap refuses that
// second one, the install gives its client back first and creates the new one
// in its slot (giveBackInstallClients). Setup and logout remove the client. The
// server can remove the client too (ur.io's Proxies page, a trim, the idle
// reap): once the health check gives up on it, the next connect asks the server
// whether it still has it and provisions anew if not (savedClientRemoved). Every
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
import { PROXY_CONTROL_REFUSALS, isControlRefusal, type ProxyView } from "../utils/proxy-control";
import { chromeStorageAdapter } from "../utils/storage-adapter";
import { BRIDGE_CAPABILITIES, BRIDGE_PORT_NAME, type PortRequestFrame } from "./protocol";
import { activeProxyClientIds, authNetworkClient, removeNetworkClient } from "./api";
import { buildAuthParams } from "../utils/auth-params";
import { parseJwtClaims } from "../utils/jwt-claims";
import { networkTokenRenewalTime, renewNetworkToken } from "@urnetwork/sdk/client";
import { extensionApiClient } from "../utils/api-client";
import {
	OWN_SESSION_RENEW_ALARM,
	OWN_SIGN_IN_MIGRATION_ALARM,
	SIGNED_OUT,
	STORAGE_KEY_OWN_SESSION_ID,
	STORAGE_KEY_OWN_SIGN_IN_MIGRATION,
	defaultOwnSignInSettings,
	migrateOwnSignIn,
	migrationDue,
	migrationRetryDelayMs,
	ownSessionMark,
	redeemOwnSignIn,
	renewalDraw,
	revokeSession,
	sessionIdOf,
	type OwnSignInMigrationState,
} from "../utils/own-sign-in";
import type { CodeSignInAnswer } from "../utils/code-sign-in";
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
	BEST_AVAILABLE_LOCATION_KEY,
	connectLocationKey,
	connectLocationPageId,
	locationIdKey,
} from "../utils/connect-location-key";
import { clearFailedClient, clearProxyHealth, failedClientId } from "../utils/proxy-health";
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

const ownSignInSettings = defaultOwnSignInSettings();

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
	// Another extension that holds the browser's proxy setting with priority, or
	// policy, keeps this one from setting it: refused before anything is
	// provisioned, and never applied under it (utils/proxy-manager.ts).
	const { control } = await proxyManager.readControl();
	if (isControlRefusal(control)) {
		const refusal = PROXY_CONTROL_REFUSALS[control];
		return { ok: false, error: refusal.message, code: refusal.code };
	}
	const networkId = jwtNetworkId(jwt);

	const record = await loadBridgeSession();
	if (
		record &&
		!record.replaceOnConnect &&
		(!record.networkId || record.networkId === networkId) &&
		recordLocationKey(record) === connectLocationKey(location) &&
		!(await savedClientRemoved(record, jwt))
	) {
		return applySavedClient(record, jwt, networkId);
	}
	return provisionClient(location, jwt, networkId);
}

// Whether the server removed the saved client. The server can remove a client
// the install still holds (ur.io's Proxies page, a trim, the idle reap after 30
// days), and the proxy then refuses every request through it, so applying it
// again only fails the health check again. It is asked only once the health
// check gave up on the client (utils/proxy-health.ts), since the answer walks
// the network's active clients. A list that does not come back keeps the client
// and asks again on the next connect; a list that has it ends the question.
async function savedClientRemoved(record: BridgeSessionRecord, jwt: string): Promise<boolean> {
	if (!record.clientId || (await failedClientId()) !== record.clientId) return false;
	const activeClientIds = await activeProxyClientIds(jwt);
	if (activeClientIds === null) return false;
	if (activeClientIds.has(record.clientId)) {
		await clearFailedClient();
		return false;
	}
	return true;
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
// removed: the first connect, another network's saved client, a saved client
// the server removed, or a location no ur.io tab could move the hosted device
// to. At the plan's proxy cap the new client is refused while the network
// still holds the one it replaces; the install then gives its client back and
// creates the new one in that slot (giveBackInstallClients), since it keeps one.
// `giveBack: false` keeps the refusal instead, and the browser on the client
// it has (a replacement nobody asked for: migrateToOwnSignIn).
async function provisionClient(
	location: ConnectLocation | undefined,
	jwt: string,
	networkId: string | null,
	options: { giveBack?: boolean } = {},
): Promise<ConnectOutcome> {
	const authParams = buildAuthParams(location, await loadPerformanceProfile());
	let result = await authNetworkClient(authParams, jwt);
	const gaveBack =
		options.giveBack !== false &&
		Boolean(result.error?.client_limit_exceeded) &&
		(await giveBackInstallClients(jwt, networkId));
	if (gaveBack) {
		result = await authNetworkClient(authParams, jwt);
	}
	// the replacement did not happen after the install gave its clients back
	const replacementFailed = async () => {
		if (gaveBack) {
			await leaveGivenBackProxy();
		}
	};

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
		await replacementFailed();
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
		await replacementFailed();
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
		await replacementFailed();
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
	await clearFailedClient();
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

// Gives back the install's own clients, the saved client and an older
// version's pool, so that a replacement the plan's proxy cap refused can take
// their slot: the clients are released, staying pending if a release fails,
// and the saved record goes. The browser's proxy setting is left as it is, so
// a connected browser never goes direct here: its requests fail until the
// replacement is applied over it. An older version's pool of 5 fills the free
// plan's cap by itself, so without this its upgrade could never connect. A
// first connect at the cap, or a saved client of another network, gives
// nothing back and keeps the refusal. Returns whether any client was given
// back.
//
// The cap and the create rate refuse alike (client_limit_exceeded), so a
// replacement the rate refused gives the client back too, and its retry is
// refused again: the browser is left off the proxy (leaveGivenBackProxy) with
// the server's "try again in a minute".
async function giveBackInstallClients(jwt: string, networkId: string | null): Promise<boolean> {
	const record = await loadBridgeSession();
	if (record?.networkId && record.networkId !== networkId) {
		return false;
	}
	const clientIds = await liveClientIds();
	if (clientIds.length === 0) {
		return false;
	}
	await addPendingReleaseClients(clientIds);
	closeAllDeviceRpcConnections("device session replaced");
	await clearBridgeSession();
	await chromeStorageAdapter.removeItem(STORAGE_KEY_CLIENT_ID);
	await chromeStorageAdapter.removeItem(STORAGE_KEY_MULTI_CLIENT_IDS);
	await chrome.storage.local.remove(MULTI_IP_SLOTS_KEY);
	await releaseBridgeClients([], [], jwt);
	return true;
}

// The replacement failed after the install gave its clients back, so the
// browser may still point at a client that is gone. It is taken off, unless
// the kill switch keeps the browser off the internet until a connect succeeds.
async function leaveGivenBackProxy(): Promise<void> {
	if (!(await getKillSwitch())) {
		try {
			await proxyManager.disable();
		} catch {
			// the next connect or the health check takes it off
		}
	}
	await clearProxyHealth();
	broadcast("SESSION_CHANGED", { session: await getSessionInfo(), reason: "disconnect" });
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
	await clearFailedClient();

	const session = await disconnectInternal(reason, jwt);
	await releaseBridgeClients([], [], jwt);
	return session;
}

// Replaces the extension's identity with `jwt`: `own` for a sign-in the
// extension redeemed itself (its session is marked, STORAGE_KEY_OWN_SESSION_ID),
// else a token a page handed over, whose session is the page's.
async function setupInternal(
	jwt: string,
	networkName: string | undefined,
	own: boolean,
): Promise<{ user: BridgeUser }> {
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
	// the old sign-in is over: its own session is signed out on the server,
	// unless it is the one being set up again
	if (oldJwt && sessionIdOf(oldJwt) !== sessionIdOf(jwt)) {
		await revokeOwnSessionInternal(oldJwt);
	}

	const storageData: Record<string, string> = { by_jwt: jwt };
	const name =
		networkName ?? (typeof claims.network_name === "string" ? claims.network_name : undefined);
	if (name) {
		storageData.network_name = name;
	}
	if (own) {
		storageData[STORAGE_KEY_OWN_SESSION_ID] = ownSessionMark(jwt);
	} else {
		await chrome.storage.local.remove(STORAGE_KEY_OWN_SESSION_ID);
	}
	// a new identity starts any migration afresh: a sign-in of its own needs
	// none, and a page's token is tried at once (migrateToOwnSignIn)
	await endMigrationState();
	await chrome.storage.local.set(storageData);

	// keep the popup in sync
	chrome.runtime
		.sendMessage({ type: "JWT_RECEIVED", jwt, networkName: name })
		.catch(() => {});

	const user = await getUser();
	broadcast("USER_CHANGED", { user });
	return { user };
}

// SETUP with a sign-in code: the code is redeemed for a sign-in of the
// extension's own and checked before anything changes (utils/own-sign-in.ts);
// only then is the old identity torn down and the new one stored. A failure
// leaves the old identity as it was and rejects with the code the page
// branches on. The redemption waits on the network outside the serialized
// operations; the swap is serialized.
async function setupWithCode(
	authCode: string,
	networkId: string | undefined,
	networkName: string | undefined,
): Promise<{ user: BridgeUser; jwt: string }> {
	const jwt = await redeemOwnSignIn(extensionApiClient(), authCode, networkId, ownSignInSettings);
	const { user } = await serialize(() => setupInternal(jwt, networkName, true));
	return { user, jwt };
}

type RenewStatus = "renewed" | "no_session" | "signed_out";

// Renews the extension's own token now (POST /auth/network-refresh with that
// token): a fresh token of the same session, with the network's claims as
// they stand (a payment's Pro). Run serialized. A rejection is the server
// ending the sign-in, and the extension signs out locally. Rejects when the
// renewal did not come back (no answer, a server error): the token stays.
// Nothing reconnects: the live proxy authenticates with its signed proxy id,
// and every token consumer reads `by_jwt` at call time.
async function renewInternal(): Promise<RenewStatus> {
	const jwt = await getJwt();
	if (!jwt) {
		return "no_session";
	}
	const renewal = await renewNetworkToken(extensionApiClient(), jwt);
	// the popup can sign out, or in, while the renewal is out: the answer is
	// about a token the extension no longer holds, and the one it holds now
	// is left as it is
	const current = await getJwt();
	if (current !== jwt) {
		return current ? "renewed" : "no_session";
	}
	if (renewal.kind === "rejected") {
		await endSignInInternal();
		return "signed_out";
	}

	const storageData: Record<string, string> = { by_jwt: renewal.byJwt };
	const name = parseJwtClaims(renewal.byJwt)?.network_name;
	if (typeof name === "string" && name) {
		storageData.network_name = name;
	}
	// a renewal is the same sign-in: one of the extension's own stays its own
	// (the server can tag an untagged one with a session as it renews)
	if (await isOwnSignIn(jwt)) {
		storageData[STORAGE_KEY_OWN_SESSION_ID] = ownSessionMark(renewal.byJwt);
	}
	await chrome.storage.local.set(storageData);
	// keep the popup in sync (same signal SETUP sends); app tabs get
	// USER_CHANGED from the storage.onChanged listener
	chrome.runtime
		.sendMessage({ type: "JWT_RECEIVED", jwt: renewal.byJwt, networkName: storageData.network_name })
		.catch(() => {});
	await scheduleOwnSessionRenewal(renewal.byJwt);
	return "renewed";
}

// An older page's push of its fresh token after a payment or an upgrade
// (REFRESH_JWT). Adopting it would share the page's session again, so the
// extension renews its own token instead, which carries the same new claims,
// and answers refreshed: the page then does not fall back to SETUP {jwt}. A
// renewal that did not come back answers refreshed too; the token stays, and
// its alarm renews it later.
//
// Statuses (returned as data, not thrown, so the page can branch):
//   refreshed     — the extension renewed its own token, or will
//   no_session    — no stored identity, or the renewal found the sign-in
//                   ended and the extension signed out
//   wrong_network — the pushed token is another network's than the stored
//                   one; that is an account switch, which must go through
//                   SETUP's atomic teardown, so the page falls back to it
async function refreshJwtInternal(
	pushedJwt: string,
): Promise<{ status: "refreshed" | "no_session" | "wrong_network"; user?: BridgeUser }> {
	const claims = parseJwtClaims(pushedJwt);
	if (!claims) {
		throw new Error("Invalid token");
	}
	if (claims.guest_mode) {
		// same defensive stance as SETUP
		throw new Error("Guest sessions cannot refresh the extension.");
	}

	const jwt = await getJwt();
	if (!jwt) {
		return { status: "no_session" };
	}
	if (
		typeof claims.network_id !== "string" ||
		!claims.network_id ||
		jwtNetworkId(jwt) !== claims.network_id
	) {
		return { status: "wrong_network" };
	}

	try {
		if ((await renewInternal()) !== "renewed") {
			return { status: "no_session" };
		}
	} catch {
		// no answer: the token stays, and its renewal alarm tries again
	}
	return { status: "refreshed", user: await getUser() };
}

// The server ended the extension's sign-in (a renewal rejected: revoked in the
// account's Sessions, signed out, expired). Signed out locally the way the
// popup's own sign-out does (ConnectScreen handleLogout): the install's client
// goes with the identity (endInternal), then the identity, its network name
// and the popup's location pick. The ended token can release nothing, so the
// client stays pending for the next sign-in's pass (utils/client-release.ts).
// Nothing is signed out on the server, which ended the session itself.
async function endSignInInternal(): Promise<void> {
	await endInternal("signed_out", null);
	await chrome.storage.local.remove([
		"by_jwt",
		"network_name",
		STORAGE_KEY_OWN_SESSION_ID,
		STORAGE_KEY_SELECTED_LOCATION,
	]);
	await chrome.alarms.clear(OWN_SESSION_RENEW_ALARM);
	await endMigrationState();
	// an open popup goes back to its sign-in (utils/code-sign-in.ts onSignedOut)
	chrome.runtime.sendMessage({ type: SIGNED_OUT }).catch(() => {});
	broadcast("USER_CHANGED", { user: null });
}

// Signs the extension's own session out on the server (utils/own-sign-in.ts
// revokeSession): best effort, bounded, never failing the local sign-out. Only
// the session the extension signed in itself: a token a page handed over is
// the page's session, and a token without a session_id cannot be signed out
// by id.
async function revokeOwnSessionInternal(jwt: string | null): Promise<void> {
	const sessionId = jwt ? sessionIdOf(jwt) : null;
	if (!jwt || !sessionId) {
		return;
	}
	const stored = await chrome.storage.local.get(STORAGE_KEY_OWN_SESSION_ID);
	if (stored[STORAGE_KEY_OWN_SESSION_ID] !== sessionId) {
		return;
	}
	await revokeSession(extensionApiClient(), jwt, sessionId, ownSignInSettings);
}

// Sets the renewal alarm of the extension's own sign-in at the point of
// `jwt`'s lifetime the sdk renews at (networkTokenRenewalTime: between 40% and
// 50% of it, drawn at random; now for a token past it or without an
// expiration), or clears it with no token.
async function scheduleOwnSessionRenewal(jwt: string | null): Promise<void> {
	if (!jwt) {
		await chrome.alarms.clear(OWN_SESSION_RENEW_ALARM);
		return;
	}
	await chrome.alarms.create(OWN_SESSION_RENEW_ALARM, {
		when: networkTokenRenewalTime(jwt, Date.now(), renewalDraw()),
	});
}

// At service worker start: a token without a renewal alarm gets one. An alarm
// already set is kept, a retry's among them: the worker starts as often as
// every minute (the health check's alarm), and must not move it.
async function ensureOwnSessionRenewal(): Promise<void> {
	// both read as the worker starts
	const [alarm, stored] = await Promise.all([
		chrome.alarms.get(OWN_SESSION_RENEW_ALARM),
		chrome.storage.local.get("by_jwt"),
	]);
	const jwt = typeof stored.by_jwt === "string" && stored.by_jwt ? stored.by_jwt : null;
	if (alarm || !jwt) {
		return;
	}
	await scheduleOwnSessionRenewal(jwt);
}

// The renewal alarm fired: renew now. A renewal that did not come back is
// tried again after renewRetryMs, unless the identity changed meanwhile and
// set its own alarm.
function renewFromAlarm(): Promise<void> {
	return serialize(async () => {
		const jwt = await getJwt();
		try {
			await renewInternal();
		} catch {
			if (jwt && (await getJwt()) === jwt) {
				await chrome.alarms.create(OWN_SESSION_RENEW_ALARM, {
					when: Date.now() + ownSignInSettings.renewRetryMs,
				});
			}
		}
	});
}

// Whether `jwt` is a sign-in the extension made itself (its mark is stored).
async function isOwnSignIn(jwt: string): Promise<boolean> {
	const stored = await chrome.storage.local.get(STORAGE_KEY_OWN_SESSION_ID);
	return stored[STORAGE_KEY_OWN_SESSION_ID] === ownSessionMark(jwt);
}

// ---- the migration to a session of the extension's own ---------------------
//
// An install from before the extension signed in itself holds ur.io's token
// (an older page's SETUP {jwt}, an older version's SET_JWT), so it shares
// ur.io's session, and ur.io's sign-out signs it out. Owner decision
// 2026-11-18, "Migrate automatically": at its next start the extension creates
// a sign-in code with the token it holds, redeems it for a session of its own,
// checks it as SETUP does (utils/own-sign-in.ts migrateOwnSignIn), and only
// then switches over. ur.io's session is left alone, never signed out. It runs
// once: a try that did not happen (the session cap, a token that ended, no
// answer) keeps the old token, which goes on working, and the next try waits on
// a backoff (OwnSignInSettings.migrationRetryMs, a few tries a day at most),
// from a state kept in storage so that a service worker starting every minute
// tries no more often, and on an alarm. A try is counted before it is made: one
// the worker does not finish counts as one that did not happen.

export type OwnSignInMigrationOutcome = "not_needed" | "waiting" | "migrated" | "failed";

async function loadMigrationState(): Promise<OwnSignInMigrationState | null> {
	const stored = await chrome.storage.local.get(STORAGE_KEY_OWN_SIGN_IN_MIGRATION);
	const value = stored[STORAGE_KEY_OWN_SIGN_IN_MIGRATION] as Partial<OwnSignInMigrationState> | undefined;
	if (!value || typeof value.failures !== "number" || typeof value.nextAttemptAt !== "number") {
		return null;
	}
	return { failures: value.failures, nextAttemptAt: value.nextAttemptAt };
}

// No migration to come: its state and its alarm go.
async function endMigrationState(): Promise<void> {
	await chrome.storage.local.remove(STORAGE_KEY_OWN_SIGN_IN_MIGRATION);
	await chrome.alarms.clear(OWN_SIGN_IN_MIGRATION_ALARM);
}

// Whether the stored sign-in is one to migrate: a member's sign-in of a
// network that the extension did not make itself.
async function needsOwnSignInMigration(jwt: string): Promise<boolean> {
	const claims = parseJwtClaims(jwt);
	if (!claims || claims.guest_mode || typeof claims.network_id !== "string" || !claims.network_id) {
		return false;
	}
	return !(await isOwnSignIn(jwt));
}

// the try under way: a worker start and the alarm that come together share it
let migrationInFlight: Promise<OwnSignInMigrationOutcome> | null = null;

/**
 * The migration to a session of the extension's own, at the service worker's
 * start (background/index.ts) and on its alarm: a try now when one is due,
 * else nothing before the next try's time.
 */
export function migrateToOwnSignIn(): Promise<OwnSignInMigrationOutcome> {
	if (!migrationInFlight) {
		migrationInFlight = migrateToOwnSignInOnce().finally(() => {
			migrationInFlight = null;
		});
	}
	return migrationInFlight;
}

async function migrateToOwnSignInOnce(): Promise<OwnSignInMigrationOutcome> {
	const heldJwt = await getJwt();
	if (!heldJwt || !(await needsOwnSignInMigration(heldJwt))) {
		await endMigrationState();
		return "not_needed";
	}
	const now = Date.now();
	const state = await loadMigrationState();
	if (!migrationDue(state, now) && state) {
		// a start between tries: the alarm brings the next one (an alarm the
		// browser dropped is set again)
		if (!(await chrome.alarms.get(OWN_SIGN_IN_MIGRATION_ALARM))) {
			await chrome.alarms.create(OWN_SIGN_IN_MIGRATION_ALARM, { when: state.nextAttemptAt });
		}
		return "waiting";
	}
	// counted before it is made
	const failures = (state?.failures ?? 0) + 1;
	const next: OwnSignInMigrationState = {
		failures,
		nextAttemptAt: now + migrationRetryDelayMs(failures, ownSignInSettings),
	};
	await chrome.storage.local.set({ [STORAGE_KEY_OWN_SIGN_IN_MIGRATION]: next });
	await chrome.alarms.create(OWN_SIGN_IN_MIGRATION_ALARM, { when: next.nextAttemptAt });

	let ownJwt: string;
	try {
		ownJwt = await migrateOwnSignIn(extensionApiClient(), heldJwt, ownSignInSettings);
	} catch (err) {
		console.warn("The move to a sign-in of the extension's own did not happen; tried again later:", err);
		return "failed";
	}
	const switched = await serialize(() => switchToOwnSignInInternal(heldJwt, ownJwt));
	if (!switched) {
		// the popup signed out, or in, while the code was redeemed: the sign-in
		// is not used, and is signed out so the account's list does not keep it
		const sessionId = sessionIdOf(ownJwt);
		if (sessionId) {
			await revokeSession(extensionApiClient(), ownJwt, sessionId, ownSignInSettings);
		}
		// the identity it was for is gone: the next start looks afresh
		await endMigrationState();
		return "not_needed";
	}
	await endMigrationState();
	return "migrated";
}

// The switch to the sign-in of the extension's own that the migration
// redeemed, in place of ur.io's token it still holds: the same network, so
// nothing is torn down and ur.io's session is left alone. The install's client
// was made with ur.io's token and carries ur.io's session, whose sign-out
// deactivates it, so it is replaced by one made with the extension's own
// (replaceSharedSessionClient). Run serialized. False when the extension no
// longer holds `heldJwt`.
async function switchToOwnSignInInternal(heldJwt: string, ownJwt: string): Promise<boolean> {
	if ((await getJwt()) !== heldJwt) {
		return false;
	}
	// marked before the switch, so a worker that stops between the two leaves
	// the client to the next connect to replace
	const record = await loadBridgeSession();
	if (record) {
		await saveBridgeSession({ ...record, replaceOnConnect: true });
	}
	const storageData: Record<string, string> = {
		by_jwt: ownJwt,
		[STORAGE_KEY_OWN_SESSION_ID]: ownSessionMark(ownJwt),
	};
	const name = parseJwtClaims(ownJwt)?.network_name;
	if (typeof name === "string" && name) {
		storageData.network_name = name;
	}
	await chrome.storage.local.set(storageData);
	// keep the popup in sync; app tabs get USER_CHANGED from the storage listener
	chrome.runtime
		.sendMessage({ type: "JWT_RECEIVED", jwt: ownJwt, networkName: storageData.network_name })
		.catch(() => {});
	await replaceSharedSessionClient(ownJwt);
	return true;
}

// The install's client made with ur.io's token: while the browser is connected
// through it, a new one at its location is made with the extension's own token
// and applied, and it is removed (provisionClient, without giving the client
// back at the plan's cap: the browser stays on the client it has, and the
// next connect replaces it, replaceOnConnect). Not connected, it is given back
// now, and the next connect makes one anew.
async function replaceSharedSessionClient(ownJwt: string): Promise<void> {
	const record = await loadBridgeSession();
	const storedClientId = await chromeStorageAdapter.getItem(STORAGE_KEY_CLIENT_ID);
	if (!record && !storedClientId) {
		return;
	}
	if (record && (await getSessionInfo()).connected) {
		try {
			await provisionClient(recordLocation(record), ownJwt, jwtNetworkId(ownJwt), { giveBack: false });
		} catch {
			// the browser stays on the client it has, for the next connect to replace
		}
		return;
	}
	await addPendingReleaseClients(
		[record?.clientId, storedClientId].filter((id): id is string => Boolean(id)),
	);
	await clearBridgeSession();
	await chromeStorageAdapter.removeItem(STORAGE_KEY_CLIENT_ID);
	await clearFailedClient();
	await releaseBridgeClients([], [], ownJwt);
}

// The connect location a saved client's hosted device runs at, from its key.
function recordLocation(record: BridgeSessionRecord): ConnectLocation | undefined {
	const key = recordLocationKey(record);
	if (key === BEST_AVAILABLE_LOCATION_KEY) {
		return undefined;
	}
	try {
		return { connect_location_id: JSON.parse(key) as unknown } as ConnectLocation;
	} catch {
		return pageLocation(record.locationId ?? null);
	}
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
			return { version: chrome.runtime.getManifest().version, ...BRIDGE_CAPABILITIES };
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
				// out of data, this extension holds the browser's traffic whatever
				// the kill switch says (utils/proxy-health.ts); an older one goes
				// direct with it off, so a page says which one it talks to
				outOfDataHeld: true,
			};
		}
		case "GET_USER": {
			return { user: await getUser() };
		}
		case "GET_SESSION": {
			return { session: await getSessionInfo() };
		}
		case "SETUP": {
			const networkName =
				typeof payload?.networkName === "string" ? payload.networkName : undefined;
			const authCode = payload?.authCode;
			if (typeof authCode === "string" && authCode) {
				const networkId =
					typeof payload?.networkId === "string" && payload.networkId
						? payload.networkId
						: undefined;
				// the extension's token never crosses into the page: the answer
				// is the user alone
				const { user } = await setupWithCode(authCode, networkId, networkName);
				return { user };
			}
			// an older page hands over its own token, and the extension shares
			// the page's session
			const jwt = payload?.jwt;
			if (typeof jwt !== "string" || !jwt) {
				throw new Error("Missing jwt");
			}
			return await serialize(() => setupInternal(jwt, networkName, false));
		}
		case "RENEW_SESSION": {
			// serialized so a renewal cannot interleave with a SETUP/DISCONNECT
			// that is swapping the stored identity underneath it
			return { status: await serialize(() => renewInternal()) };
		}
		case "REFRESH_JWT": {
			const jwt = payload?.byJwt;
			if (typeof jwt !== "string" || !jwt) {
				throw new Error("Missing byJwt");
			}
			// serialized like RENEW_SESSION
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

// logout: the client goes with the identity, released with the identity's
// token, and then the extension's own session is signed out on the server
// while the token is still at hand (the popup forgets it after this answers),
// so the account's Sessions list does not keep a signed-out extension
export function endFromPopup(): Promise<BridgeSessionInfo> {
	return serialize(async () => {
		const jwt = await getJwt();
		try {
			return await endInternal("logout", jwt);
		} finally {
			await revokeOwnSessionInternal(jwt);
			await chrome.storage.local.remove(STORAGE_KEY_OWN_SESSION_ID);
			await endMigrationState();
		}
	});
}

// The popup's code sign-in, and SSO's (background/index.ts): the same sign-in
// of the extension's own as SETUP with a code, of any network. Never rejects:
// a refusal answers with its code, which the popup words
// (utils/code-sign-in.ts). The popup gets the token, as JWT_RECEIVED gives it.
export async function signInWithCode(authCode: string): Promise<CodeSignInAnswer> {
	try {
		const { user, jwt } = await setupWithCode(authCode, undefined, undefined);
		return { success: true, jwt, networkName: user?.networkName ?? undefined };
	} catch (err) {
		const failure = err as { message?: unknown; code?: unknown } | null;
		return {
			success: false,
			code: typeof failure?.code === "string" ? failure.code : undefined,
			error: typeof failure?.message === "string" ? failure.message : undefined,
		};
	}
}

export function sessionForPopup(): Promise<BridgeSessionInfo> {
	return getSessionInfo();
}

// The proxy as the popup shows it (utils/connection-manager.ts): whether the
// browser sends through this extension's proxy, who holds the setting, and the
// saved connect intent.
export async function proxyViewForPopup(): Promise<ProxyView> {
	const [state, reading, stored] = await Promise.all([
		proxyManager.getActualProxyState(),
		proxyManager.readControl(),
		chrome.storage.local.get("proxy_enabled"),
	]);
	proxyManager.syncState(state);
	return { enabled: state.enabled, control: reading.control, intent: Boolean(stored.proxy_enabled) };
}

// An older version kept a pool of hosted proxies behind a PAC script
// (Chromium) or a listener (Firefox). On upgrade a connected pool is replaced
// by the install's one client at the popup's last pick, and every pool client
// is released. A failed connect leaves the pool as it is, for the next start.
// Only this extension's own PAC script is its pool: another extension's
// (getActualProxyState reports none) is never connected over.
export async function migrateLegacyMultiIp(): Promise<void> {
	const legacyClientIds = await storedMultiClientIds();
	const stored = await chrome.storage.local.get(["proxy_enabled", MULTI_IP_SLOTS_KEY]);
	const state = await proxyManager.getActualProxyState();
	const poolConnected =
		(state.enabled && state.mode === "pac") ||
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
		if (alarm.name === OWN_SESSION_RENEW_ALARM) {
			renewFromAlarm().catch(() => {});
		}
		if (alarm.name === OWN_SIGN_IN_MIGRATION_ALARM) {
			migrateToOwnSignIn().catch(() => {});
		}
	});

	// the worker starts: its own sign-in keeps a renewal alarm
	ensureOwnSessionRenewal().catch(() => {});

	// USER_CHANGED for every identity change, whichever surface caused it
	// (popup login, bridge SETUP, a renewal), and the renewal alarm
	// set for the identity's token, or cleared without one
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.by_jwt || changes.network_name) {
			getUser()
				.then((user) => broadcast("USER_CHANGED", { user }))
				.catch(() => {});
		}
		if (changes.by_jwt) {
			const jwt = changes.by_jwt.newValue;
			scheduleOwnSessionRenewal(typeof jwt === "string" && jwt ? jwt : null).catch(() => {});
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
