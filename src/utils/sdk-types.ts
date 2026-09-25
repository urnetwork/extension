// The sdk's wire types the extension handles, by their public names.
//
// The popup's React hooks (useAuthNetworkClient, useAPI…) and URNetworkAPI are
// typed with the Go-reflected wire types (sdk/js/src/generated/types.ts),
// which no package entry point exports; the generated api client uses the
// OpenAPI types (`OpenAPI.*`), which are exported but describe the same JSON
// more loosely (few required fields, no nulls, and a narrower proxy_config).
// Derive the Go-reflected ones from URNetworkAPI's public signatures rather
// than deep-importing the sdk's files.
import type { URNetworkAPI } from "@urnetwork/sdk/client";

/** POST /network/auth-client, as the popup hook and buildAuthParams shape it */
export type AuthNetworkClientArgs = Parameters<URNetworkAPI["authNetworkClient"]>[0];

type ProxyConfig = NonNullable<AuthNetworkClientArgs["proxy_config"]>;
type ProxyDeviceState = NonNullable<ProxyConfig["initial_device_state"]>;

/**
 * A location the user can connect to: a country/region/city, a location
 * group, or a device. The popup persists the selected one (JSON) and hands it
 * to buildAuthParams.
 */
export type ConnectLocation = NonNullable<ProxyDeviceState["location"]>;
