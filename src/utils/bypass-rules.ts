const BYPASS_HOSTS = [
	"localhost",
	"127.0.0.1",
	"api.bringyour.com",
];

const BYPASS_SUFFIXES = [".local"];

// The device-rpc endpoint of the proxy we are connected to (api.<proxyHost>).
//
// The /app device plane dials wss://api.<proxyHost>:<apiPort> to CONTROL the
// hosted device. That control channel must never be routed through the very
// proxy it controls: it is a routing loop (the proxy would be asked to carry
// the connection that manages it), it makes the control plane unrecoverable
// whenever the data plane is unhealthy, and in Firefox — where every request
// is resolved by this extension's own proxy.onRequest listener — the loop
// deadlocks the entire browser, parent process included, at 0% CPU.
//
// The proxy config host is `<signedProxyId>.<proxyHost>`, so the api host is
// `api.` + everything after the first label. Derived per session rather than
// hardcoded, because the proxy host varies per connect.
export function deviceRpcApiHost(proxyConfigHost: string | undefined): string | null {
	if (!proxyConfigHost) return null;
	const dot = proxyConfigHost.indexOf(".");
	if (dot <= 0) return null;
	return `api.${proxyConfigHost.slice(dot + 1)}`;
}

export function shouldBypass(hostname: string, extraHosts: readonly string[] = []): boolean {
	if (BYPASS_HOSTS.includes(hostname)) return true;
	if (extraHosts.includes(hostname)) return true;
	for (const suffix of BYPASS_SUFFIXES) {
		if (hostname.endsWith(suffix)) return true;
	}
	return false;
}

export function pacBypassConditions(extraHosts: readonly string[] = []): string {
	const conditions = [
		`if (host === "localhost" || host === "127.0.0.1" || isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";`,
		`if (host === "api.bringyour.com") return "DIRECT";`,
	];
	for (const host of extraHosts) {
		conditions.push(`if (host === ${JSON.stringify(host)}) return "DIRECT";`);
	}
	conditions.push(`if (shExpMatch(host, "*.local")) return "DIRECT";`);
	return conditions.join("\n  ");
}

const CHROME_BYPASS_BASE = ["localhost", "127.0.0.1", "<local>", "api.bringyour.com"];

export function chromeBypassList(extraHosts: readonly string[] = []): string[] {
	return [...CHROME_BYPASS_BASE, ...extraHosts.filter((h) => !CHROME_BYPASS_BASE.includes(h))];
}

export const CHROME_BYPASS_LIST = CHROME_BYPASS_BASE;
