import { proxyManager } from "../utils/proxy-manager";
import { requestHealthCheck, type ProxyHealthTrigger } from "../utils/proxy-health";
import { concernsNotifications } from "../utils/alerts-permission";
import { getKillSwitch } from "../utils/kill-switch";
import { applyKillSwitchSetting } from "../utils/kill-switch-apply";
import {
	connectFromPopup,
	disconnectFromPopup,
	endFromPopup,
	handleExtensionLocationChange,
	initBridge,
	migrateLegacyMultiIp,
	migrateToOwnSignIn,
	notifySessionChanged,
	proxyViewForPopup,
	signInWithCode,
} from "../bridge/background";
import type { ConnectLocation } from "../utils/sdk-types";
import { initDeviceRpcBridge } from "../bridge/device-rpc";
import { startSsoFlow } from "../utils/sso";
import type { FirefoxGlobal } from "../types/firefox-webext";
import type { CodeSignInAnswer } from "../utils/code-sign-in";
import { POPUP_CODE_SIGN_IN } from "../utils/own-sign-in";

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
// the install's one client (bridge/background.ts migrateLegacyMultiIp), then
// move an install that still holds ur.io's token to a session of its own
// (migrateToOwnSignIn: once, with tries on a backoff).
function restoreThenMigrate(): void {
	proxyManager
		.restoreState()
		.catch((err) => {
			console.error("Failed to restore proxy state on startup:", err);
		})
		.then(() => migrateLegacyMultiIp())
		.catch((err) => {
			console.error("Failed to replace the multi-IP pool:", err);
		})
		.then(() => migrateToOwnSignIn())
		.catch((err) => {
			console.error("Failed to move to a sign-in of the extension's own:", err);
		});
}

// Firefox: restore proxy listener immediately — no need to wait for Chrome's
// proxy.settings.get() to settle. The 2-second delay only benefits Chrome.
if ((globalThis as FirefoxGlobal).browser?.proxy?.onRequest) {
	restoreThenMigrate();
} else {
	setTimeout(restoreThenMigrate, 2_000);
}

// SSO's page hands back a sign-in code, which signs the extension in with a
// session of its own, as the popup's code entry does (bridge/background.ts
// signInWithCode: the redemption's request id, the typed refusals, and
// JWT_RECEIVED for the popup).
async function completeSsoLogin(code: string): Promise<CodeSignInAnswer> {
	const answer = await signInWithCode(code);
	if (!answer.success) {
		console.error("SSO code-login failed:", answer.code ?? answer.error);
	}
	return answer;
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
				// a refusal answers its code: the popup says the session cap's
				// (utils/code-sign-in.ts)
				const answer = await completeSsoLogin(result.code);
				sendResponse(
					answer.success
						? { success: true }
						: { success: false, code: answer.code, error: answer.error },
				);
			})
			.catch((err: Error) => {
				console.error("SSO flow failed:", err);
				sendResponse({ success: false, error: err.message });
			});
		return true;
	}

	// The popup's code entry (utils/code-sign-in.ts): the code is redeemed here,
	// so a popup that closes mid-way loses nothing.
	if (message.type === POPUP_CODE_SIGN_IN) {
		signInWithCode(typeof message.authCode === "string" ? message.authCode.trim() : "").then(
			sendResponse,
		);
		return true;
	}

	return false;
});

// ── External messages ─────────────────────────────────────────────────────────

// None (owner decision 2026-11-18). The legacy external SET_JWT, which stored a
// page's own token as the extension's sign-in, is gone with its
// externally_connectable entry (manifest.config.ts): a page can no longer
// reach the background directly, and the extension signs in only with a
// session of its own (SETUP with a sign-in code over the content-channel
// bridge, the popup's code entry, SSO; utils/own-sign-in.ts).

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
