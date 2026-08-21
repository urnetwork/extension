// Shared origin allowlist for every page-facing surface (external messages and
// the app content-channel bridge). Hostnames match exactly or as subdomains.
const ALLOWED_ORIGINS = ["ur.io", "manager.bringyour.com", "localhost"];

export function isAllowedOrigin(url: string | undefined): boolean {
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
