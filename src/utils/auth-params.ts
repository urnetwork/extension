import type { AuthNetworkClientArgs, ConnectLocation, PerformanceProfile } from "./sdk-types";

// The device's IANA time zone, BCP 47 locale and ordered languages ride on
// every auth-client call: the campaign emails are placed in the reader's day
// and written in their language (server controller/mail_context.go).
// Optional on the wire.

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

// The browser's languages, most preferred first (navigator.languages; Firefox
// with resistFingerprinting lists only one). The whole list, so a reader who
// lists Catalan, then Spanish, reads the Spanish emails.
export function deviceLocales(): string[] {
	try {
		const languages = Array.isArray(navigator.languages) ? navigator.languages : [navigator.language];
		return languages.filter((language) => typeof language === "string" && language !== "").slice(0, 8);
	} catch {
		return [];
	}
}

// Shared auth-client provisioning params. Used by the popup connection manager
// and the background bridge service so both provision identically. No location
// means best available. The performance profile is the user's connect options
// (utils/performance-profile.ts); null is the sdk's auto.
export function buildAuthParams(
	location?: ConnectLocation,
	performanceProfile: PerformanceProfile | null = null,
): AuthNetworkClientArgs {
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
		locales: deviceLocales(),
		proxy_config: {
			lock_caller_ip: false,
			lock_ip_list: [],
			enable_socks: true,
			enable_http: true,
			http_require_auth: false,
			// Keep the server's defaults: URL-token HTTPS auth, no WireGuard leg.
			https_require_auth: false,
			enable_wg: false,
			initial_device_state: {
				location: locationConfig,
				performance_profile: performanceProfile,
			},
		},
	};
}
