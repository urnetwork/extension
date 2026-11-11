// The client info the extension reports with its api calls (X-UR-ClientInfo,
// built by the sdk's clientInfoHeaders): device type web, the extension's
// version and the build's distribution. The server keeps the device type and
// version with each session's last use, which the account's Sessions list
// shows, and reads the device type and distribution for the account's
// onboarding platform when the extension authenticates its client.
//
// The distribution follows the build target (vite.config.ts BROWSER_TARGET,
// defined as __EXTENSION_BROWSER_TARGET__): the Firefox build, or the Chrome
// build for the Chromium browsers' stores.
/// <reference path="../env.d.ts" />
import { ClientDistribution, clientInfoHeaders } from "@urnetwork/sdk/client";

export const EXTENSION_DEVICE_TYPE = "web";

export const EXTENSION_DISTRIBUTION: ClientDistribution =
	__EXTENSION_BROWSER_TARGET__ === "firefox" ? ClientDistribution.ExtensionFirefox : ClientDistribution.ExtensionChrome;

/** The X-UR-ClientInfo header for every request of an api client the extension creates. */
export function extensionClientInfoHeaders(): Record<string, string> {
	return clientInfoHeaders({
		deviceType: EXTENSION_DEVICE_TYPE,
		appVersion: __EXTENSION_VERSION__,
		distribution: EXTENSION_DISTRIBUTION,
	});
}
