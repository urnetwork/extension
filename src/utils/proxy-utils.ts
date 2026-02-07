import type { ProxyConfig } from "./proxy-manager";

/**
 * Parse a proxy URL into a ProxyConfig
 * Supports formats like:
 * - socks5://host:port
 * - http://host:port
 * - https://host:port
 * - socks5://username:password@host:port
 */
export function parseProxyUrl(proxyUrl: string): ProxyConfig | null {
	try {
		const url = new URL(proxyUrl);

		const scheme = url.protocol.replace(":", "") as
			| "http"
			| "https"
			| "socks4"
			| "socks5";

		// Validate scheme
		if (!["http", "https", "socks4", "socks5"].includes(scheme)) {
			console.error("Invalid proxy scheme:", scheme);
			return null;
		}

		const config: ProxyConfig = {
			scheme,
			host: url.hostname,
			port: parseInt(url.port) || (scheme === "https" ? 443 : 1080),
		};

		// Extract username/password if present
		if (url.username) {
			config.username = decodeURIComponent(url.username);
		}
		if (url.password) {
			config.password = decodeURIComponent(url.password);
		}

		return config;
	} catch (error) {
		console.error("Failed to parse proxy URL:", error);
		return null;
	}
}

/**
 * Convert a ProxyConfig back to a URL string
 */
export function proxyConfigToUrl(config: ProxyConfig): string {
	const auth =
		config.username && config.password
			? `${encodeURIComponent(config.username)}:${encodeURIComponent(config.password)}@`
			: "";

	return `${config.scheme}://${auth}${config.host}:${config.port}`;
}
