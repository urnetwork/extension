// Decode-only JWT claims parsing (no signature verification — the extension
// treats the by_jwt as an opaque credential; claims are used for display and
// identity comparison only).
export type JwtClaims = {
	network_id?: string;
	network_name?: string;
	client_id?: string;
	user_id?: string;
	guest_mode?: boolean;
	[key: string]: unknown;
};

export function parseJwtClaims(jwt: string): JwtClaims | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	try {
		const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes)) as JwtClaims;
	} catch {
		return null;
	}
}
