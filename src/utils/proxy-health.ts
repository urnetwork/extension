// The background's health check of the install's one proxy. background/index.ts
// asks for it every minute and on every proxy error the browser reports
// (requestHealthCheck). It fetches a url through the browser's proxy
// settings, so a failure means the proxy is not carrying traffic.
//
// One check runs at a time: a request while one runs shares its outcome. A
// failure counts at most once every failureSpacingMs, and a proxy error that
// arrives within that time of a counted failure starts no check, so a burst of
// proxy errors in an outage (each page's requests, and the probe's own) counts
// once, and the run of failures keeps the one-minute schedule: three failures
// in a row take about two minutes, as the alarm alone does.
//
// What a run of failures does depends on the kill switch (owner, 2026-10-02:
// off by default):
// - off: the extension takes the proxy off, releasing the browser's proxy
//   setting (utils/proxy-manager.ts disable), since a Chromium fixed_servers
//   proxy has no fallback of its own. The install's client stays saved, and
//   the next connect applies it again;
// - on: the proxy stays set and traffic stops until it answers again (fail
//   closed).
// Firefox's listener already falls back to direct per request while the kill
// switch is off (utils/proxy-manager.ts), so there the probe reads healthy and
// only a kill switch that is on sees the failures.
//
// Out of balance is not a failure of the proxy (owner, 2026-11-11). A failed
// probe reads the account balance (bridge/api.ts subscriptionBalance), and
// with no data left the check starts an out-of-balance episode: the proxy
// stays set whatever the kill switch says (on Firefox too: no per-request
// direct while it lasts), the popup shows the out-of-data alert, the toolbar
// icon a "!", and one browser notification is posted once the browser allows
// it: the user turned alerts on in the popup (utils/alerts-permission.ts),
// before the episode or during it. A permission taken back during the episode
// lets a later grant post it anew (utils/out-of-balance.ts). Nothing falls
// back to direct for it. The episode ends with a passing check, a balance that
// has data again, a connect or a disconnect; while it lasts, a balance that
// does not come back keeps it.
//
// The failure count lives in storage because the service worker can stop
// between two runs. So do the episode and what a run last told the popup
// (utils/proxy-health-report.ts), for a popup that opens after it.
import { proxyManager } from "./proxy-manager";
import { getKillSwitch } from "./kill-switch";
import { getMessage } from "./i18n";
import { parseJwtClaims } from "./jwt-claims";
import { notificationsGranted } from "./alerts-permission";
import {
	isOutOfData,
	clearOutOfDataBadge,
	clearOutOfDataNotification,
	postOutOfDataNotification,
	showOutOfDataBadge,
	type BalanceReading,
} from "./out-of-balance";
import {
	STORAGE_KEY_OUT_OF_BALANCE,
	STORAGE_KEY_PROXY_HEALTH_REPORT,
	outOfBalanceEpisode,
	type OutOfBalanceEpisode,
	type OutOfBalancePlan,
	type ProxyHealthReport,
} from "./proxy-health-report";
import { subscriptionBalance } from "../bridge/api";
import type { FirefoxGlobal } from "../types/firefox-webext";

export type ProxyHealthSettings = {
	// fetched through the proxy, so it must not be on the bypass list
	probeUrl: string;
	// ms before a probe counts as failed
	probeTimeoutMs: number;
	// failed runs in a row before the kill switch decides; non-positive never
	// takes the proxy off
	failuresBeforeFallback: number;
	// ms that must pass after a counted failure before another failure counts,
	// and before a proxy error starts a check. Under the one-minute schedule,
	// so a late alarm still counts.
	failureSpacingMs: number;
};

export function defaultProxyHealthSettings(): ProxyHealthSettings {
	return {
		probeUrl: "https://api-v4.bringyour.com/my-ip-info",
		probeTimeoutMs: 8_000,
		// three failures of the one-minute schedule: a proxy host restart or a
		// brief network loss recovers inside it
		failuresBeforeFallback: 3,
		failureSpacingMs: 45_000,
	};
}

export const STORAGE_KEY_PROXY_HEALTH_FAILURES = "proxy_health_failures";
// when the last counted failure was, ms
export const STORAGE_KEY_PROXY_HEALTH_FAILED_AT = "proxy_health_failed_at";
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
// switch, a failing proxy taken off, or an account with no data left (the
// proxy kept set). "skipped": a proxy error right after a counted failure,
// which starts no check.
export type ProxyHealthOutcome =
	| "idle"
	| "healthy"
	| "failing"
	| "unreachable"
	| "fell_back"
	| "out_of_balance"
	| "skipped";

// what asked for a check: the one-minute schedule, or a proxy error the
// browser reported (and the popup's request for one)
export type ProxyHealthTrigger = "scheduled" | "proxy_error";

function isFirefox(): boolean {
	return Boolean((globalThis as FirefoxGlobal).browser?.proxy?.onRequest);
}

async function loadFailures(): Promise<{ count: number; at: number | null }> {
	const result = await chrome.storage.local.get([
		STORAGE_KEY_PROXY_HEALTH_FAILURES,
		STORAGE_KEY_PROXY_HEALTH_FAILED_AT,
	]);
	const count = result[STORAGE_KEY_PROXY_HEALTH_FAILURES];
	const at = result[STORAGE_KEY_PROXY_HEALTH_FAILED_AT];
	return {
		count: typeof count === "number" && 0 < count ? count : 0,
		at: typeof at === "number" ? at : null,
	};
}

/**
 * Starts the failure count afresh and ends a fallback, an out-of-balance
 * episode, and the report a popup would open to (a connect or disconnect).
 */
export async function clearProxyHealth(): Promise<void> {
	const episode = await outOfBalanceEpisode();
	await chrome.storage.local.remove([
		STORAGE_KEY_PROXY_HEALTH_FAILURES,
		STORAGE_KEY_PROXY_HEALTH_FAILED_AT,
		STORAGE_KEY_PROXY_FALLBACK_AT,
		STORAGE_KEY_PROXY_HEALTH_REPORT,
		STORAGE_KEY_OUT_OF_BALANCE,
	]);
	proxyManager.setTrafficHold(false);
	if (episode) {
		await clearOutOfDataNotification();
		await clearOutOfDataBadge();
	}
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
function tellPopup(outcome: ProxyHealthOutcome, plan?: OutOfBalancePlan): void {
	const message = plan ? { type: "PROXY_HEALTH", outcome, plan } : { type: "PROXY_HEALTH", outcome };
	chrome.runtime.sendMessage(message).catch(() => {});
}

// keeps a failure report for a popup that opens later, then tells an open one
async function reportFailure(report: Exclude<ProxyHealthReport, "out_of_balance">): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY_PROXY_HEALTH_REPORT]: report });
	tellPopup(report);
}

// The account's balance as out of data or not, or null when it did not come
// back: no jwt, or the api did not answer.
async function readBalance(): Promise<{ outOfData: boolean; plan: OutOfBalancePlan } | null> {
	const { by_jwt: jwt } = await chrome.storage.local.get("by_jwt");
	if (typeof jwt !== "string" || jwt === "") return null;
	let reading: BalanceReading | null;
	try {
		reading = await subscriptionBalance(jwt);
	} catch {
		reading = null;
	}
	if (!reading) return null;
	// ur.io's Pro (AuthContext isPro) also takes the jwt's own claim
	const pro = reading.pro || parseJwtClaims(jwt)?.pro === true;
	return { outOfData: isOutOfData(reading), plan: pro ? "pro" : "free" };
}

// Starts or carries on an out-of-balance episode: no fallback and no failure
// counted, the proxy holds the traffic, the popup is told, the toolbar badge
// shows it, and the one notification is posted once the browser allows it.
async function holdOutOfBalance(
	plan: OutOfBalancePlan,
	episode: OutOfBalanceEpisode | null,
	now: number,
): Promise<ProxyHealthOutcome> {
	const next: OutOfBalanceEpisode = {
		plan,
		since: episode?.since ?? now,
		notified: episode?.notified ?? false,
	};
	proxyManager.setTrafficHold(true);
	// every run, so a browser restart that dropped the badge gets it back
	await showOutOfDataBadge();
	if (!next.notified) {
		next.notified = await postOutOfDataNotification(getMessage, plan === "pro", now);
	} else if (!(await notificationsGranted())) {
		// the user took the permission back: once they turn alerts on again,
		// the episode's notification is posted anew
		next.notified = false;
	}
	await chrome.storage.local.set({
		[STORAGE_KEY_OUT_OF_BALANCE]: next,
		[STORAGE_KEY_PROXY_HEALTH_REPORT]: "out_of_balance",
		// the next failure counts afresh once data is back
		[STORAGE_KEY_PROXY_HEALTH_FAILURES]: 0,
		[STORAGE_KEY_PROXY_HEALTH_FAILED_AT]: now,
	});
	tellPopup("out_of_balance", plan);
	return "out_of_balance";
}

// the balance has data again, or a check passed: the episode is over
async function endOutOfBalance(): Promise<void> {
	await chrome.storage.local.remove([STORAGE_KEY_OUT_OF_BALANCE, STORAGE_KEY_PROXY_HEALTH_REPORT]);
	proxyManager.setTrafficHold(false);
	await clearOutOfDataNotification();
	await clearOutOfDataBadge();
}

/**
 * One run of the check. `notify` is told when the proxy is taken off, so the
 * page's session snapshot follows (bridge/background.ts notifySessionChanged).
 */
export async function performHealthCheck(
	notify: (reason: string) => void = () => {},
	settings: ProxyHealthSettings = defaultProxyHealthSettings(),
	now: () => number = Date.now,
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

	// another extension's proxy, or none, is not this extension's to check
	const state = await proxyManager.getActualProxyState();
	if (!state.enabled || state.mode !== "fixed") {
		return "idle";
	}

	const failuresBefore = await loadFailures();
	const episode = await outOfBalanceEpisode();
	if (await probe(settings)) {
		if (episode) {
			await endOutOfBalance();
		}
		if (0 < failuresBefore.count || failuresBefore.at !== null || episode) {
			// a report is only ever kept after failures, so this ends it too
			await chrome.storage.local.remove([
				STORAGE_KEY_PROXY_HEALTH_FAILURES,
				STORAGE_KEY_PROXY_HEALTH_FAILED_AT,
				STORAGE_KEY_PROXY_HEALTH_REPORT,
			]);
			tellPopup("healthy");
		}
		return "healthy";
	}

	const at = now();
	// out of data: the proxy is fine, the account is not
	const balance = await readBalance();
	if (balance?.outOfData) {
		return holdOutOfBalance(balance.plan, episode, at);
	}
	if (episode) {
		if (!balance) {
			// the balance did not come back: still out of data, as far as is known
			return holdOutOfBalance(episode.plan, episode, at);
		}
		// data is back, and the proxy still does not answer: a failure like any,
		// and the popup leaves the alert for the state such a failure shows
		await endOutOfBalance();
		tellPopup("failing");
	}

	if (failuresBefore.at !== null && at - failuresBefore.at < settings.failureSpacingMs) {
		// counted already: a burst counts once
		return "failing";
	}
	const failures = failuresBefore.count + 1;
	await chrome.storage.local.set({
		[STORAGE_KEY_PROXY_HEALTH_FAILURES]: failures,
		[STORAGE_KEY_PROXY_HEALTH_FAILED_AT]: at,
	});
	if (settings.failuresBeforeFallback <= 0 || failures < settings.failuresBeforeFallback) {
		return "failing";
	}

	await markClientFailed();
	if (await getKillSwitch()) {
		// fail closed: the proxy stays set
		await reportFailure("unreachable");
		return "unreachable";
	}

	// the kill switch is off: browse without the proxy rather than through one
	// that does not answer
	await proxyManager.disable();
	await chrome.storage.local.remove([STORAGE_KEY_PROXY_HEALTH_FAILURES, STORAGE_KEY_PROXY_HEALTH_FAILED_AT]);
	await chrome.storage.local.set({ [STORAGE_KEY_PROXY_FALLBACK_AT]: at });
	notify("health");
	await reportFailure("fell_back");
	return "fell_back";
}

// the check in progress, which a request while it runs shares
let running: Promise<ProxyHealthOutcome> | null = null;

/**
 * Asks for a check: the one in progress if there is one, else a new one. A
 * proxy error within failureSpacingMs of a counted failure starts none
 * ("skipped"): it cannot count, and its own probe would fail through the same
 * proxy and report another error.
 */
export function requestHealthCheck(
	trigger: ProxyHealthTrigger,
	notify: (reason: string) => void = () => {},
	settings: ProxyHealthSettings = defaultProxyHealthSettings(),
	now: () => number = Date.now,
): Promise<ProxyHealthOutcome> {
	if (running) return running;
	const run = (async (): Promise<ProxyHealthOutcome> => {
		if (trigger === "proxy_error") {
			const { at } = await loadFailures();
			if (at !== null && now() - at < settings.failureSpacingMs) return "skipped";
		}
		return performHealthCheck(notify, settings, now);
	})();
	running = run;
	const done = () => {
		if (running === run) running = null;
	};
	run.then(done, done);
	return run;
}
