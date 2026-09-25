// URnetwork api calls for the background bridge service, over the sdk's
// generated api client (utils/api-client.ts). The popup uses the SDK React
// hooks for the same endpoints; the background service worker calls them
// directly with the stored by_jwt, passed in per call.
import { isURNetworkApiError, type OpenAPI } from "@urnetwork/sdk/client";
import { extensionApiClient } from "../utils/api-client";
import type { AuthNetworkClientArgs } from "../utils/sdk-types";

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
		// buildAuthParams shapes the Go struct (sdk/js/src/generated/types.ts):
		// the same JSON the spec describes, with nulls and the proxy flags
		// (enable_socks, enable_http, …) the spec's schema leaves out. Re-typed
		// here, at the wire, like the sdk's own URNetworkAPI does.
		const result = await extensionApiClient().authNetworkClient(
			args as unknown as OpenAPI.AuthNetworkClientArgs,
			{ token: byJwt },
		);
		// a handled failure is a 200 with an `error` field
		return {
			...result,
			proxy_config_result: (result.proxy_config_result ?? null) as BridgeProxyConfigResult | null,
			error: result.error
				? { ...result.error, message: result.error.message ?? "Auth network client failed" }
				: null,
		};
	} catch (error) {
		if (isURNetworkApiError(error) && error.kind === "http") {
			return {
				proxy_config_result: null,
				error: {
					message: `HTTP error! status: ${error.status}`,
					client_limit_exceeded: false,
					// 402 is the plan-limit signal (see AuthNetworkClientError.UpgradeRequired)
					upgrade_required: error.status === 402,
				},
			};
		}
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
		await extensionApiClient().removeNetworkClient({ client_id: clientId }, { token: byJwt });
	} catch {
		// ignore
	}
}
