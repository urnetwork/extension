import { proxyManager } from "../utils/proxy-manager";
import { requestHealthCheck, type ProxyHealthTrigger } from "../utils/proxy-health";
import { concernsNotifications } from "../utils/alerts-permission";
import { getKillSwitch } from "../utils/kill-switch";
import { applyKillSwitchSetting } from "../utils/kill-switch-apply";
import { isAllowedOrigin } from "../utils/origins";
import {
	connectFromPopup,
	disconnectFromPopup,
	endFromPopup,
	handleExtensionLocationChange,
	initBridge,
	migrateLegacyMultiIp,
	notifySessionChanged,
	proxyViewForPopup,
} from "../bridge/background";
import type { ConnectLocation } from "../utils/sdk-types";
import { initDeviceRpcBridge } from "../bridge/device-rpc";
import { startSsoFlow, clearSsoState, retrieveAndValidateState } from "../utils/sso";
import type { FirefoxGlobal } from "../types/firefox-webext";
import { extensionApiClient } from "../utils/api-client";
import { isURNetworkApiError } from "@urnetwork/sdk/client";

const HEALTH_ALARM_NAME = "node-health-check";

// app content-channel bridge (ur.io app ↔ extension)
initBridge();
initDeviceRpcBridge();

function isFirefox(): boolean {
	return Boolean((globalThis as FirefoxGlobal).browser?.proxy?.onRequest);
}

// Register Firefox proxy error listener
const firefoxProxy = (globalThis as FirefoxGlobal).browser?.proxy;
if (firefoxProxy?.onError) {
	firefoxProxy.onError.addListener((error: { message: string }) => {
		console.error("Firefox proxy error:", error.message);
		triggerEarlyHealthCheck();
	});
}

// Register Chrome proxy error listener
if (!isFirefox() && chrome.proxy?.onProxyError) {
	chrome.proxy.onProxyError.addListener((details) => {
		console.error("Chrome proxy error:", details.error, details.details);
		triggerEarlyHealthCheck();
	});
}

// Chromium: another extension can take the proxy setting, or give it back,
// while the popup is open; the popup shows who holds it
// (utils/connection-manager.ts PROXY_CONTROL)
if (!isFirefox() && chrome.proxy?.settings?.onChange) {
	chrome.proxy.settings.onChange.addListener(() => {
		proxyViewForPopup()
			.then((view) => chrome.runtime.sendMessage({ type: "PROXY_CONTROL", view }))
			.catch(() => {});
	});
}

// ── Health check system ───────────────────────────────────────────────────────

// One check at a time, and a burst of proxy errors counts once
// (utils/proxy-health.ts requestHealthCheck).
function healthCheck(trigger: ProxyHealthTrigger): void {
	requestHealthCheck(trigger, notifySessionChanged).catch((err) => {
		console.error(`Health check (${trigger}) failed:`, err);
	});
}

function triggerEarlyHealthCheck(): void {
	healthCheck("proxy_error");
}

// Set up recurring health check alarm
chrome.alarms.create(HEALTH_ALARM_NAME, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === HEALTH_ALARM_NAME) {
		healthCheck("scheduled");
	}
});

// The user turned alerts on in the popup (utils/alerts-permission.ts). The
// popup can close while the browser asks, so the grant is acted on here: a
// check now, which posts the notification of an out-of-data episode in
// progress (utils/proxy-health.ts), rather than at the next scheduled one.
// Registered at the top level, so the event wakes the background.
chrome.permissions?.onAdded?.addListener((permissions) => {
	if (concernsNotifications(permissions)) {
		healthCheck("scheduled");
	}
});

// what a failed popup request answers with: the error, its code, and the proxy
// as it stands after the failure (a failed connect can leave the proxy set)
async function popupFailure(error: unknown, code: unknown): Promise<Record<string, unknown>> {
	return {
		success: false,
		error: typeof error === "string" ? error : undefined,
		code: typeof code === "string" ? code : undefined,
		view: await proxyViewForPopup().catch(() => undefined),
	};
}

// a thrown error's message and code (utils/proxy-manager.ts ProxyControlError)
function thrownFailure(err: unknown): Promise<Record<string, unknown>> {
	const failure = err as { message?: unknown; code?: unknown } | null;
	return popupFailure(failure?.message, failure?.code);
}

// ── Startup ───────────────────────────────────────────────────────────────────

// Restore the saved proxy, then replace an older version's multi-IP pool with
// the install's one client (bridge/background.ts migrateLegacyMultiIp).
function restoreThenMigrate(): void {
	proxyManager
		.restoreState()
		.catch((err) => {
			console.error("Failed to restore proxy state on startup:", err);
		})
		.then(() => migrateLegacyMultiIp())
		.catch((err) => {
			console.error("Failed to replace the multi-IP pool:", err);
		});
}

// Firefox: restore proxy listener immediately — no need to wait for Chrome's
// proxy.settings.get() to settle. The 2-second delay only benefits Chrome.
if ((globalThis as FirefoxGlobal).browser?.proxy?.onRequest) {
	restoreThenMigrate();
} else {
	setTimeout(restoreThenMigrate, 2_000);
}

// ── SSO tab listener (legacy fallback for non-identity flows) ───────────────────
// The main flow now uses chrome.identity.launchWebAuthFlow, which delivers the
// auth code directly to the extension via a browser-controlled redirect URL.
// This listener is kept only as a safety net for any legacy/manual tab flow.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	const url = changeInfo.url;
	if (!url || !isSsoCompleteUrlLegacy(url)) return;

	const parsed = parseSsoCompleteUrlLegacy(url);
	if (!parsed) return;

	(async () => {
		const valid = await retrieveAndValidateState(parsed.state);
		if (!valid) {
			console.warn("SSO state mismatch or expired, ignoring callback");
			return;
		}

		await clearSsoState();
		await completeSsoLogin(parsed.code);
		chrome.tabs.remove(tabId).catch(() => {});
	})();
});

async function completeSsoLogin(code: string): Promise<void> {
	let jwt: string | undefined;
	try {
		// public route: no Authorization is sent
		const result = await extensionApiClient().authCodeLogin({ auth_code: code });
		jwt = result.by_jwt;
	} catch (error) {
		console.error(
			"SSO code-login failed:",
			isURNetworkApiError(error) && error.kind === "http" ? error.status : error,
		);
		return;
	}
	if (!jwt) {
		console.error("SSO code-login returned no JWT");
		return;
	}

	await chrome.storage.local.set({ by_jwt: jwt });

	chrome.runtime
		.sendMessage({ type: "JWT_RECEIVED", jwt })
		.catch(() => {});
}

function isSsoCompleteUrlLegacy(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "https:" &&
			parsed.hostname === "manager.bringyour.com" &&
			parsed.pathname === "/login-extension/complete"
		);
	} catch {
		return false;
	}
}

function parseSsoCompleteUrlLegacy(url: string): { code: string; state: string } | null {
	try {
		const parsed = new URL(url);
		const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
		const hashParams = new URLSearchParams(hash);
		const code = hashParams.get("code");
		const state = hashParams.get("state");
		if (!code || !state) return null;
		return { code, state };
	} catch {
		return null;
	}
}

// ── Internal SSO handler ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	if (message.type === "START_SSO") {
		startSsoFlow()
			.then(async (result) => {
				if (!result) {
					sendResponse({ success: false, error: "SSO flow failed" });
					return;
				}
				await completeSsoLogin(result.code);
				sendResponse({ success: true });
			})
			.catch((err: Error) => {
				console.error("SSO flow failed:", err);
				sendResponse({ success: false, error: err.message });
			});
		return true;
	}

	return false;
});

// ── External messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessageExternal.addListener(
	(message, sender, sendResponse) => {
		if (!isAllowedOrigin(sender.url)) {
			console.warn("Message from unauthorized origin:", sender.url);
			sendResponse({ success: false, error: "Unauthorized origin" });
			return false;
		}

		if (message.type === "SET_JWT" && typeof message.jwt === "string") {
			const storageData: Record<string, string> = { by_jwt: message.jwt };
			if (typeof message.networkName === "string") {
				storageData.network_name = message.networkName;
			}

			chrome.storage.local.set(storageData, () => {
				if (chrome.runtime.lastError) {
					console.error("Failed to store JWT:", chrome.runtime.lastError);
					sendResponse({ success: false, error: "Storage error" });
					return;
				}

				sendResponse({ success: true });

				chrome.runtime
					.sendMessage({
						type: "JWT_RECEIVED",
						jwt: message.jwt,
						networkName: message.networkName,
					})
					.catch(() => {});
			});

			return true;
		}

		sendResponse({ success: false, error: "Unknown message type" });
		return false;
	},
);

// ── Internal messages ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	// The popup's connection (utils/connection-manager.ts): the install's one
	// client, owned here so a closed popup ends nothing (bridge/background.ts).
	if (message.type === "POPUP_CONNECT") {
		const location =
			message.location && typeof message.location === "object"
				? (message.location as ConnectLocation)
				: undefined;
		// a failure answers with the proxy as it stands: a location change that
		// failed can leave the install's previous proxy set
		connectFromPopup(location)
			.then((outcome) =>
				outcome.ok
					? { success: true, session: outcome.session }
					: popupFailure(outcome.error, outcome.code),
			)
			.catch((err: Error) => {
				console.error("Failed to connect:", err);
				return thrownFailure(err);
			})
			.then(sendResponse);
		return true;
	}

	if (message.type === "POPUP_DISCONNECT" || message.type === "POPUP_END_SESSION") {
		const end = message.type === "POPUP_END_SESSION";
		(end ? endFromPopup() : disconnectFromPopup())
			.then(async (session) => ({
				success: true,
				session,
				view: await proxyViewForPopup().catch(() => undefined),
			}))
			.catch((err: Error) => {
				console.error("Failed to disconnect:", err);
				return thrownFailure(err);
			})
			.then(sendResponse);
		return true;
	}

	if (message.type === "GET_VPN_STATE") {
		proxyViewForPopup()
			.then((view) => sendResponse({ success: true, state: proxyManager.getState(), view }))
			.catch((err: Error) => {
				console.error("Failed to get VPN state:", err);
				sendResponse({ success: true, state: proxyManager.getState() });
			});

		return true;
	}

	if (message.type === "SET_KILL_SWITCH") {
		const enabled = Boolean(message.enabled);
		applyKillSwitchSetting(enabled)
			.then(() => sendResponse({ success: true }))
			.catch((err: Error) => {
				console.error("Failed to set kill switch:", err);
				sendResponse({ success: false, error: err.message });
			});
		return true;
	}

	if (message.type === "GET_KILL_SWITCH") {
		getKillSwitch().then((enabled) => {
			sendResponse({ success: true, enabled });
		});
		return true;
	}

	// The popup changed the connect location. If an app tab is attached, the
	// change is delegated to its DeviceRemote (device-rpc, no proxy reconnect,
	// no new client); otherwise the popup connects at the location, which
	// replaces the install's client. See bridge/background.ts.
	if (message.type === "CHANGE_LOCATION") {
		handleExtensionLocationChange(
			typeof message.locationId === "string" ? message.locationId : null,
			typeof message.name === "string" ? message.name : undefined,
		)
			.then((r) => sendResponse({ success: true, delegated: r.delegated }))
			.catch((err: Error) => sendResponse({ success: false, error: err.message }));
		return true;
	}

	if (message.type === "TRIGGER_HEALTH_CHECK") {
		triggerEarlyHealthCheck();
		sendResponse({ success: true });
		return true;
	}

	return false;
});
