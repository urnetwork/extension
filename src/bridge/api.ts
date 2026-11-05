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

// the server's own reason in an error body, if it gave one
function bodyReason(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const error = (body as { error?: unknown }).error;
	if (typeof error === "string" && error !== "") return error;
	if (typeof error === "object" && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message !== "") return message;
	}
	return null;
}

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
			// 402 is the plan-limit signal (see AuthNetworkClientError.UpgradeRequired):
			// the server answers a refused proxy or client with its reason in the
			// body ({error: "..."} from x402, or {error: {message}}), which the
			// page shows as is
			const planLimit = error.status === 402;
			return {
				proxy_config_result: null,
				error: {
					message: bodyReason(error.body) ?? `HTTP error! status: ${error.status}`,
					client_limit_exceeded: planLimit,
					upgrade_required: planLimit,
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

// Never rejects. Resolves false when the release did not reach the server, or
// met a server error, and is worth retrying: a client that is not removed
// stays active until the server's idle reap (about 30 days after its last
// use), counting against the network's cap of active proxies, so the caller
// keeps it pending (utils/client-release.ts). A refusal (4xx, or a handled
// error in the body) will not change on a retry and resolves true.
export async function removeNetworkClient(clientId: string, byJwt: string): Promise<boolean> {
	try {
		await extensionApiClient().removeNetworkClient({ client_id: clientId }, { token: byJwt });
		return true;
	} catch (error) {
		if (isURNetworkApiError(error) && error.kind === "http") {
			return error.status < 500 && error.status !== 429;
		}
		return false;
	}
}
