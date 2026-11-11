// What the background's health check (utils/proxy-health.ts) last told the
// popup about the install's proxy, kept for as long as it holds so that a
// popup opened later shows what a popup open all along was told
// (utils/connection-manager.ts reattach):
// - unreachable: the proxy failed its checks and the kill switch keeps it set;
// - fell_back: the proxy failed its checks and was taken off;
// - out_of_balance: a check failed because the account has no data left, and
//   the proxy stays set whatever the kill switch says (an out-of-balance
//   episode, kept with its plan under STORAGE_KEY_OUT_OF_BALANCE).
// A passing check, a connect and a disconnect end it. Its own module so the
// popup and the proxy manager read it without loading the health check.
export type ProxyHealthReport = "unreachable" | "fell_back" | "out_of_balance";

// free: the free plan, which the next free grant (00:00 UTC), an upgrade or a
// data pack ends; pro: a Pro account at its plan's data, which is never
// offered an upgrade (the apps' "Data limit reached")
export type OutOfBalancePlan = "free" | "pro";

export type OutOfBalanceEpisode = {
	plan: OutOfBalancePlan;
	// when the episode started, ms
	since: number;
	// whether its one browser notification was posted
	notified: boolean;
};

export const STORAGE_KEY_PROXY_HEALTH_REPORT = "proxy_health_report";
export const STORAGE_KEY_OUT_OF_BALANCE = "proxy_out_of_balance";

/** The report that holds, if any. */
export async function proxyHealthReport(): Promise<ProxyHealthReport | null> {
	const result = await chrome.storage.local.get(STORAGE_KEY_PROXY_HEALTH_REPORT);
	return parseReport(result[STORAGE_KEY_PROXY_HEALTH_REPORT]);
}

export function parseReport(value: unknown): ProxyHealthReport | null {
	return value === "unreachable" || value === "fell_back" || value === "out_of_balance" ? value : null;
}

export function parsePlan(value: unknown): OutOfBalancePlan | null {
	return value === "free" || value === "pro" ? value : null;
}

/** The out-of-balance episode in progress, if any. */
export async function outOfBalanceEpisode(): Promise<OutOfBalanceEpisode | null> {
	const result = await chrome.storage.local.get(STORAGE_KEY_OUT_OF_BALANCE);
	const value = result[STORAGE_KEY_OUT_OF_BALANCE] as Partial<OutOfBalanceEpisode> | undefined;
	const plan = parsePlan(value?.plan);
	if (!value || !plan) return null;
	return {
		plan,
		since: typeof value.since === "number" ? value.since : 0,
		notified: value.notified === true,
	};
}

/** The report that holds, with the plan of an out-of-balance one. */
export async function proxyHealthReportWithPlan(): Promise<{
	report: ProxyHealthReport;
	plan: OutOfBalancePlan | null;
} | null> {
	const report = await proxyHealthReport();
	if (!report) return null;
	if (report !== "out_of_balance") return { report, plan: null };
	return { report, plan: (await outOfBalanceEpisode())?.plan ?? "free" };
}
