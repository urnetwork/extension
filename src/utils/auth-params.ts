import type { ConnectLocation, AuthNetworkClientArgs } from "node_modules/@urnetwork/sdk/dist/generated";

// The device's IANA time zone and BCP 47 locale ride on every auth-client
// call: the onboarding campaign sends in the user's local morning and picks
// the email's language from them (mmm/onboarding/PLAN.md). Optional on the
// wire; the published SDK types predate the fields, so they are typed here
// until the package catches up.
export type AuthNetworkClientArgsWithDevice = AuthNetworkClientArgs & { time_zone?: string; locale?: string };

export function deviceTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	} catch {
		return "";
	}
}

export function deviceLocale(): string {
	try {
		return navigator.language || "";
	} catch {
		return "";
	}
}

// Shared auth-client provisioning params. Used by the popup connection manager
// and the background bridge service so both provision identically. No location
// means best available.
export function buildAuthParams(location?: ConnectLocation): AuthNetworkClientArgsWithDevice {
	const locationConfig = location
		? {
				connect_location_id: {
					location_id: location.connect_location_id?.location_id,
					location_group_id: location.connect_location_id?.location_group_id,
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
		time_zone: deviceTimeZone(),
		locale: deviceLocale(),
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
