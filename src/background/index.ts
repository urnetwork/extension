import { proxyManager, type ProxyConfig } from "../utils/proxy-manager";
import { buildPacScript, pacScriptToDataUrl, type PacSlot } from "../utils/pac-script";
import { runHealthCheck, getSortedSlots } from "../utils/node-health";
import { getKillSwitch } from "../utils/kill-switch";
import { applyKillSwitchSetting } from "../utils/kill-switch-apply";
import { isAllowedOrigin } from "../utils/origins";
import { initBridge, notifySessionChanged, handleExtensionLocationChange } from "../bridge/background";
import { startSsoFlow, clearSsoState, retrieveAndValidateState } from "../utils/sso";

const HEALTH_ALARM_NAME = "node-health-check";
const MULTI_IP_SLOTS_KEY = "multi_ip_slots";

// app content-channel bridge (ur.io app ↔ extension)
initBridge();

function isFirefox(): boolean {
	return Boolean((globalThis as any).browser?.proxy?.onRequest);
}

// Register Firefox proxy error listener
const firefoxProxy = (globalThis as any).browser?.proxy;
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

// ── Health check system ───────────────────────────────────────────────────────

async function performHealthCheck(): Promise<void> {
	const state = proxyManager.getState();

	// Firefox defensive check: if storage says we should be connected but the
	// onRequest listener is no longer active (background was terminated and
	// restarted), re-run restoreState() to re-register the listener immediately,
	// then return early. The next alarm tick (up to 1 minute) will run the full
	// health-check pass with fresh in-memory state.
	if (isFirefox() && !proxyManager.isListenerActive()) {
		const stored = await chrome.storage.local.get("proxy_enabled");
		if (stored["proxy_enabled"]) {
			await proxyManager.restoreState();
			return;
		}
	}

	if (!state.enabled || state.mode !== "pac") return;

	const result = await chrome.storage.local.get(MULTI_IP_SLOTS_KEY);
	const raw = result[MULTI_IP_SLOTS_KEY] as string | undefined;
	if (!raw) return;

	let slots: PacSlot[];
	try {
		slots = JSON.parse(raw) as PacSlot[];
	} catch {
		return;
	}

	if (slots.length === 0) return;

	const health = await runHealthCheck(slots);
	const sorted = getSortedSlots(slots, health);

	if (isFirefox()) {
		proxyManager.enableMultiIp(sorted);
	} else {
		const killSwitch = await getKillSwitch();
		const pacScript = buildPacScript(sorted, { killSwitch });
		const dataUrl = pacScriptToDataUrl(pacScript);

		chrome.proxy.settings.set({
			value: { mode: "pac_script", pacScript: { url: dataUrl } },
			scope: "regular",
		});
	}

	await chrome.storage.local.set({ [MULTI_IP_SLOTS_KEY]: JSON.stringify(sorted) });
}

function triggerEarlyHealthCheck(): void {
	performHealthCheck().catch((err) => {
		console.error("Health check failed:", err);
	});
}

// Set up recurring health check alarm
chrome.alarms.create(HEALTH_ALARM_NAME, { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === HEALTH_ALARM_NAME) {
		performHealthCheck().catch((err) => {
			console.error("Scheduled health check failed:", err);
		});
	}
});

// ── Startup ───────────────────────────────────────────────────────────────────

// Firefox: restore proxy listener immediately — no need to wait for Chrome's
// proxy.settings.get() to settle. The 2-second delay only benefits Chrome.
if ((globalThis as any).browser?.proxy?.onRequest) {
	proxyManager.restoreState().catch((err) => {
		console.error("Failed to restore Firefox proxy state on startup:", err);
	});
} else {
	setTimeout(() => {
		proxyManager.restoreState().catch((err) => {
			console.error("Failed to restore proxy state on startup:", err);
		});
	}, 2_000);
}

// ── SSO tab listener (legacy fallback for non-identity flows) ───────────────────
// The main flow now uses chrome.identity.launchWebAuthFlow, which delivers the
// auth code directly to the extension via a browser-controlled redirect URL.
// This listener is kept only as a safety net for any legacy/manual tab flow.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
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
	const response = await fetch("https://api.bringyour.com/auth/code-login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ auth_code: code }),
	});

	if (!response.ok) {
		console.error("SSO code-login failed:", response.status);
		return;
	}

	const result = await response.json();
	const jwt = result.by_jwt;
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
			parsed.hostname === "beta.app.ur.network" &&
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
	if (message.type === "ENABLE_VPN") {
		if (!message.config) {
			sendResponse({ success: false, error: "Missing proxy config" });
			return false;
		}

		proxyManager
			.enable(message.config as ProxyConfig)
			.then(() => {
				sendResponse({ success: true });
				notifySessionChanged("connect");
			})
			.catch((err: Error) => {
				console.error("Failed to enable VPN:", err);
				sendResponse({ success: false, error: err.message });
			});

		return true;
	}

	if (message.type === "DISABLE_VPN") {
		proxyManager
			.disable()
			.then(() => {
				sendResponse({ success: true });
				notifySessionChanged("disconnect");
			})
			.catch((err: Error) => {
				console.error("Failed to disable VPN:", err);
				sendResponse({ success: false, error: err.message });
			});

		return true;
	}

	if (message.type === "SWAP_PROXY") {
		if (!message.config) {
			sendResponse({ success: false, error: "Missing proxy config" });
			return false;
		}

		proxyManager
			.swap(message.config as ProxyConfig)
			.then(() => {
				sendResponse({ success: true });
				notifySessionChanged("renew");
			})
			.catch((err: Error) => {
				console.error("Failed to swap proxy:", err);
				sendResponse({ success: false, error: err.message });
			});

		return true;
	}

	if (message.type === "GET_VPN_STATE") {
		proxyManager
			.getActualProxyState()
			.then((state) => {
				proxyManager.syncState(state);
				sendResponse({ success: true, state });
			})
			.catch((err: Error) => {
				console.error("Failed to get VPN state:", err);
				sendResponse({ success: true, state: proxyManager.getState() });
			});

		return true;
	}

	if (message.type === "ENABLE_TAB_ISOLATION_PAC") {
		if (!message.dataUrl) {
			sendResponse({ success: false, error: "Missing PAC data URL" });
			return false;
		}

		const pacConfig: chrome.proxy.ProxyConfig = {
			mode: "pac_script",
			pacScript: { url: message.dataUrl as string },
		};

		chrome.proxy.settings.set({ value: pacConfig, scope: "regular" }, () => {
			if (chrome.runtime.lastError) {
				sendResponse({ success: false, error: chrome.runtime.lastError.message });
			} else {
				sendResponse({ success: true });
				notifySessionChanged("connect");
			}
		});

		return true;
	}

	if (message.type === "DISABLE_TAB_ISOLATION_PAC") {
		chrome.proxy.settings.set(
			{ value: { mode: "direct" }, scope: "regular" },
			() => {
				const success = chrome.runtime.lastError == null;
				sendResponse({ success });
				if (success) notifySessionChanged("disconnect");
			},
		);
		return true;
	}

	if (message.type === "ENABLE_FIREFOX_MULTI_IP") {
		if (!message.slots || !Array.isArray(message.slots)) {
			sendResponse({ success: false, error: "Missing proxy slots" });
			return false;
		}
		try {
			proxyManager.enableMultiIp(message.slots);
			sendResponse({ success: true });
			notifySessionChanged("connect");
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			sendResponse({ success: false, error: msg });
		}
		return true;
	}

	if (message.type === "DISABLE_FIREFOX_MULTI_IP") {
		proxyManager.disableMultiIp();
		sendResponse({ success: true });
		notifySessionChanged("disconnect");
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
	// change is delegated to its DeviceRemote (device-rpc, no proxy reconnect);
	// otherwise the popup falls back to a normal connect/swap. See bridge.ts.
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
