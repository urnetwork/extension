const BYPASS_HOSTS = [
	"localhost",
	"127.0.0.1",
	"api.bringyour.com",
];

const BYPASS_SUFFIXES = [".local"];

export function shouldBypass(hostname: string): boolean {
	if (BYPASS_HOSTS.includes(hostname)) return true;
	for (const suffix of BYPASS_SUFFIXES) {
		if (hostname.endsWith(suffix)) return true;
	}
	return false;
}

export function pacBypassConditions(): string {
	return [
		`if (host === "localhost" || host === "127.0.0.1" || isInNet(host, "127.0.0.0", "255.0.0.0")) return "DIRECT";`,
		`if (host === "api.bringyour.com") return "DIRECT";`,
		`if (shExpMatch(host, "*.local")) return "DIRECT";`,
	].join("\n  ");
}

export const CHROME_BYPASS_LIST = ["localhost", "127.0.0.1", "<local>", "api.bringyour.com"];
