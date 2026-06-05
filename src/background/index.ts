import { proxyManager, type ProxyConfig } from "../utils/proxy-manager";
import { buildPacScript, pacScriptToDataUrl, type PacSlot } from "../utils/pac-script";
import { runHealthCheck, getSortedSlots, getStoredHealth } from "../utils/node-health";
import { getKillSwitch, setKillSwitch } from "../utils/kill-switch";

const ALLOWED_ORIGINS = ["ur.io", "ur.network", "localhost"];
const HEALTH_ALARM_NAME = "node-health-check";
const MULTI_IP_SLOTS_KEY = "multi_ip_slots";

function isAllowedOrigin(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const { hostname } = new URL(url);
		return ALLOWED_ORIGINS.some(
			(domain) => hostname === domain || hostname.endsWith(`.${domain}`),
		);
	} catch {
		return false;
	}
}

function isFirefox(): boolean {
	return Boolean((globalThis as any).browser?.proxy?.onRequest);
}

// Register Firefox proxy error listener
const firefoxProxy = (globalThis as any).browser?.proxy;
if (firefoxProxy?.onError) {
	firefoxProxy.onError.addListener((error: { message: string }) => {
		console.error("Firefox proxy error:", error.message);
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

setTimeout(() => {
	proxyManager.restoreState().catch((err) => {
		console.error("Failed to restore proxy state on startup:", err);
	});
}, 2_000);

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
			.then(() => sendResponse({ success: true }))
			.catch((err: Error) => {
				console.error("Failed to enable VPN:", err);
				sendResponse({ success: false, error: err.message });
			});

		return true;
	}

	if (message.type === "DISABLE_VPN") {
		proxyManager
			.disable()
			.then(() => sendResponse({ success: true }))
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
			.then(() => sendResponse({ success: true }))
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
			}
		});

		return true;
	}

	if (message.type === "DISABLE_TAB_ISOLATION_PAC") {
		chrome.proxy.settings.set(
			{ value: { mode: "direct" }, scope: "regular" },
			() => {
				sendResponse({ success: chrome.runtime.lastError == null });
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
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			sendResponse({ success: false, error: msg });
		}
		return true;
	}

	if (message.type === "DISABLE_FIREFOX_MULTI_IP") {
		proxyManager.disableMultiIp();
		sendResponse({ success: true });
		return true;
	}

	if (message.type === "SET_KILL_SWITCH") {
		const enabled = Boolean(message.enabled);
		(async () => {
			await setKillSwitch(enabled);
			proxyManager.setKillSwitchState(enabled);

			// Regenerate PAC on Chrome if VPN is active in pac mode
			const state = proxyManager.getState();
			if (state.enabled && state.mode === "pac" && !isFirefox()) {
				const stored = await chrome.storage.local.get(MULTI_IP_SLOTS_KEY);
				const raw = stored[MULTI_IP_SLOTS_KEY] as string | undefined;
				if (raw) {
					try {
						const slots = JSON.parse(raw) as PacSlot[];
						const health = await getStoredHealth();
						const sorted = getSortedSlots(slots, health);
						const pacScript = buildPacScript(sorted, { killSwitch: enabled });
						const dataUrl = pacScriptToDataUrl(pacScript);
						chrome.proxy.settings.set({
							value: { mode: "pac_script", pacScript: { url: dataUrl } },
							scope: "regular",
						});
					} catch { /* best effort */ }
				}
			}

			sendResponse({ success: true });
		})();
		return true;
	}

	if (message.type === "GET_KILL_SWITCH") {
		getKillSwitch().then((enabled) => {
			sendResponse({ success: true, enabled });
		});
		return true;
	}

	if (message.type === "TRIGGER_HEALTH_CHECK") {
		triggerEarlyHealthCheck();
		sendResponse({ success: true });
		return true;
	}

	return false;
});
