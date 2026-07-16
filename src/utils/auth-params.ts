import type { ConnectLocation, AuthNetworkClientArgs } from "node_modules/@urnetwork/sdk-js/dist/generated";

// Shared auth-client provisioning params. Used by the popup connection manager
// and the background bridge service so both provision identically. No location
// means best available.
export function buildAuthParams(location?: ConnectLocation): AuthNetworkClientArgs {
	const locationConfig = location
		? {
				connect_location_id: {
					location_id: location.connect_location_id?.location_id,
				},
				stable: true,
				strong_privacy: true,
			}
		: {
				connect_location_id: { best_available: true },
				stable: true,
				strong_privacy: true,
			};

	return {
		description: "",
		device_spec: "",
		proxy_config: {
			lock_caller_ip: false,
			lock_ip_list: [],
			enable_socks: true,
			enable_http: true,
			http_require_auth: false,
			initial_device_state: {
				location: locationConfig,
				performance_profile: null,
			},
		},
	};
}
