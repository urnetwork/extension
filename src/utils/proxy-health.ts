// The background's health check of the install's one proxy. background/index.ts
// runs it every minute and on every proxy error the browser reports. It fetches
// a url through the browser's proxy settings, so a failure means the proxy is
// not carrying traffic.
//
// What a run of failures does depends on the kill switch (owner, 2026-10-02:
// off by default):
// - off: the extension takes the proxy off and the browser goes direct, since
//   a Chromium fixed_servers proxy has no fallback of its own. The install's
//   client stays saved, and the next connect applies it again;
// - on: the proxy stays set and traffic stops until it answers again (fail
//   closed).
// Firefox's listener already falls back to direct per request while the kill
// switch is off (utils/proxy-manager.ts), so there the probe reads healthy and
// only a kill switch that is on sees the failures.
//
// The failure count lives in storage because the service worker can stop
// between two runs.
import { proxyManager } from "./proxy-manager";
import { getKillSwitch } from "./kill-switch";
import type { FirefoxGlobal } from "../types/firefox-webext";

export type ProxyHealthSettings = {
	// fetched through the proxy, so it must not be on the bypass list
	probeUrl: string;
	// ms before a probe counts as failed
	probeTimeoutMs: number;
	// failed runs in a row before the kill switch decides; non-positive never
	// takes the proxy off
	failuresBeforeFallback: number;
};

export function defaultProxyHealthSettings(): ProxyHealthSettings {
	return {
		probeUrl: "https://api-v4.bringyour.com/my-ip-info",
		probeTimeoutMs: 8_000,
		// three minutes of the one-minute alarm: a proxy host restart or a brief
		// network loss recovers inside it
		failuresBeforeFallback: 3,
	};
}

export const STORAGE_KEY_PROXY_HEALTH_FAILURES = "proxy_health_failures";
// when the extension last took the proxy off for a failing health check
export const STORAGE_KEY_PROXY_FALLBACK_AT = "proxy_fallback_at";
// the install's client (bridge/background.ts) that the checks last gave up on:
// taken off, or kept set by the kill switch. A connect asks the server whether
// it still has that client before it applies it again. A disconnect keeps it.
export const STORAGE_KEY_PROXY_FAILED_CLIENT_ID = "proxy_failed_client_id";
// the install's applied client (bridge/background.ts STORAGE_KEY_CLIENT_ID)
const STORAGE_KEY_CLIENT_ID = "proxy_client_id";

// What a run found: no proxy of ours to check, a healthy proxy, a failure
// that has not reached the threshold, a failing proxy kept set by the kill
// switch, or a failing proxy taken off.
export type ProxyHealthOutcome = "idle" | "healthy" | "failing" | "unreachable" | "fell_back";

function isFirefox(): boolean {
	return Boolean((globalThis as FirefoxGlobal).browser?.proxy?.onRequest);
}

async function loadFailures(): Promise<number> {
	const result = await chrome.storage.local.get(STORAGE_KEY_PROXY_HEALTH_FAILURES);
	const value = result[STORAGE_KEY_PROXY_HEALTH_FAILURES];
	return typeof value === "number" && 0 < value ? value : 0;
}

/** Starts the failure count afresh and ends a fallback (a connect or disconnect). */
export async function clearProxyHealth(): Promise<void> {
	await chrome.storage.local.remove([STORAGE_KEY_PROXY_HEALTH_FAILURES, STORAGE_KEY_PROXY_FALLBACK_AT]);
}

/** The client the checks last gave up on, if any. */
export async function failedClientId(): Promise<string | null> {
	const result = await chrome.storage.local.get(STORAGE_KEY_PROXY_FAILED_CLIENT_ID);
	const value = result[STORAGE_KEY_PROXY_FAILED_CLIENT_ID];
	return typeof value === "string" && value !== "" ? value : null;
}

/** Forgets the failed client: it was replaced, removed, or the server still has it. */
export async function clearFailedClient(): Promise<void> {
	await chrome.storage.local.remove(STORAGE_KEY_PROXY_FAILED_CLIENT_ID);
}

// Writes down the applied client as the one the checks gave up on. The server
// may have removed it (ur.io's Proxies page, a trim, the idle reap), and then
// every connect that applied it again went through a proxy that refuses it.
async function markClientFailed(): Promise<void> {
	const result = await chrome.storage.local.get(STORAGE_KEY_CLIENT_ID);
	const clientId = result[STORAGE_KEY_CLIENT_ID];
	if (typeof clientId === "string" && clientId !== "") {
		await chrome.storage.local.set({ [STORAGE_KEY_PROXY_FAILED_CLIENT_ID]: clientId });
	}
}

async function probe(settings: ProxyHealthSettings): Promise<boolean> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), settings.probeTimeoutMs);
	try {
		const res = await fetch(settings.probeUrl, { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeoutId);
	}
}

// tells an open popup (utils/connection-manager.ts); nothing listens otherwise
function tellPopup(outcome: ProxyHealthOutcome): void {
	chrome.runtime.sendMessage({ type: "PROXY_HEALTH", outcome }).catch(() => {});
}

/**
 * One run of the check. `notify` is told when the proxy is taken off, so the
 * page's session snapshot follows (bridge/background.ts notifySessionChanged).
 */
export async function performHealthCheck(
	notify: (reason: string) => void = () => {},
	settings: ProxyHealthSettings = defaultProxyHealthSettings(),
): Promise<ProxyHealthOutcome> {
	// Firefox: a restarted background lost its listener; restore it and leave
	// the check to the next run, which sees fresh state
	if (isFirefox() && !proxyManager.isListenerActive()) {
		const stored = await chrome.storage.local.get("proxy_enabled");
		if (stored["proxy_enabled"]) {
			await proxyManager.restoreState();
			return "idle";
		}
	}

	const state = await proxyManager.getActualProxyState();
	if (!state.enabled || state.mode !== "fixed") {
		return "idle";
	}

	const failuresBefore = await loadFailures();
	if (await probe(settings)) {
		if (0 < failuresBefore) {
			await chrome.storage.local.remove(STORAGE_KEY_PROXY_HEALTH_FAILURES);
			tellPopup("healthy");
		}
		return "healthy";
	}

	const failures = failuresBefore + 1;
	await chrome.storage.local.set({ [STORAGE_KEY_PROXY_HEALTH_FAILURES]: failures });
	if (settings.failuresBeforeFallback <= 0 || failures < settings.failuresBeforeFallback) {
		return "failing";
	}

	await markClientFailed();
	if (await getKillSwitch()) {
		// fail closed: the proxy stays set
		tellPopup("unreachable");
		return "unreachable";
	}

	// the kill switch is off: browse directly rather than through a proxy that
	// does not answer
	await proxyManager.disable();
	await chrome.storage.local.remove(STORAGE_KEY_PROXY_HEALTH_FAILURES);
	await chrome.storage.local.set({ [STORAGE_KEY_PROXY_FALLBACK_AT]: Date.now() });
	notify("health");
	tellPopup("fell_back");
	return "fell_back";
}
