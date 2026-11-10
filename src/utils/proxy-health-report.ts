// What the background's health check (utils/proxy-health.ts) last told the
// popup about the install's proxy, kept for as long as it holds so that a
// popup opened later shows what a popup open all along was told
// (utils/connection-manager.ts reattach):
// - unreachable: the proxy failed its checks and the kill switch keeps it set;
// - fell_back: the proxy failed its checks and was taken off.
// A passing check, a connect and a disconnect end it. Its own module so the
// popup reads it without loading the background's proxy manager.
export type ProxyHealthReport = "unreachable" | "fell_back";

export const STORAGE_KEY_PROXY_HEALTH_REPORT = "proxy_health_report";

/** The report that holds, if any. */
export async function proxyHealthReport(): Promise<ProxyHealthReport | null> {
	const result = await chrome.storage.local.get(STORAGE_KEY_PROXY_HEALTH_REPORT);
	const value = result[STORAGE_KEY_PROXY_HEALTH_REPORT];
	return value === "unreachable" || value === "fell_back" ? value : null;
}
