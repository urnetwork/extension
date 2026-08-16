// Plain-fetch URnetwork api calls for the background bridge service. The popup
// uses the sdk-js react hooks for the same endpoints; the background service
// worker calls them directly with the stored by_jwt.
import type { AuthNetworkClientArgs } from "node_modules/@urnetwork/sdk-js/dist/generated";

const API_BASE = "https://api.bringyour.com";

export type BridgeProxyConfigResult = {
	auth_token?: string;
	// Exact hosted DeviceLocal identity. DeviceRemote pairing is strict: callers
	// must never synthesize or substitute this value.
	instance_id?: string;
	proxy_host?: string;
	https_proxy_port?: number;
	// device-rpc endpoint base: https://api.<proxy_host>:<api_port>
	api_base_url?: string;
	api_port?: number;
	expiration_time?: string;
	keepalive_seconds?: number;
};

export type BridgeAuthClientError = {
	message: string;
	client_limit_exceeded?: boolean;
	upgrade_required?: boolean;
};

export type BridgeAuthClientResult = {
	by_client_jwt?: string;
	proxy_config_result: BridgeProxyConfigResult | null;
	error?: BridgeAuthClientError | null;
};

export async function authNetworkClient(
	args: AuthNetworkClientArgs,
	byJwt: string,
): Promise<BridgeAuthClientResult> {
	try {
		const response = await fetch(`${API_BASE}/network/auth-client`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${byJwt}`,
			},
			body: JSON.stringify(args),
		});

		if (!response.ok) {
			return {
				proxy_config_result: null,
				error: {
					message: `HTTP error! status: ${response.status}`,
					client_limit_exceeded: false,
					// 402 is the plan-limit signal (see AuthNetworkClientError.UpgradeRequired)
					upgrade_required: response.status === 402,
				},
			};
		}

		return (await response.json()) as BridgeAuthClientResult;
	} catch (error) {
		return {
			proxy_config_result: null,
			error: {
				message: error instanceof Error ? error.message : "Auth network client failed",
				client_limit_exceeded: false,
			},
		};
	}
}

export async function removeNetworkClient(clientId: string, byJwt: string): Promise<void> {
	// best effort — a failed remove leaves an inactive client that expires server-side
	try {
		await fetch(`${API_BASE}/network/remove-client`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${byJwt}`,
			},
			body: JSON.stringify({ client_id: clientId }),
		});
	} catch {
		// ignore
	}
}
