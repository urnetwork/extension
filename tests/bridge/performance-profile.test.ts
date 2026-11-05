// The connect options over the bridge: CONNECT may carry the page's profile,
// SET_PERFORMANCE_PROFILE hands over a change, and every client the extension
// provisions starts with the last one, including a client a location change
// with no ur.io tab open provisions. A hosted device made with no ur.io tab
// open starts from that provisioning, so before this it ran in Auto (rotating
// exits) whatever Fixed IP said. The install's one client is reused at its own
// location (bridge/background.ts); the page changes a live device's options
// over the device-rpc.
import { beforeEach, describe, expect, it } from "vitest";
import {
	createBridgeHarness,
	makeJwt,
	NETWORK_ID,
	OTHER_NETWORK_ID,
	type BridgeHarness,
	type FakePort,
} from "./harness";
import {
	AUTO,
	FIXED_IP_STREAMING,
	FIXED_IP_WEB,
	WEB,
	wireProfile,
	wireWindow,
} from "../performance-profiles";

// a provisioned session for `clientId`, valid for an hour
function provisioned(clientId: string) {
	return {
		by_client_jwt: makeJwt({ client_id: clientId }),
		proxy_config_result: {
			auth_token: "signed-proxy",
			instance_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
			expiration_time: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		},
	};
}

describe("connect options over the bridge", () => {
	let h: BridgeHarness;
	let app: FakePort;

	// the profile the n-th auth-client call provisioned the hosted device with
	const sentProfile = (call: number) =>
		h.api.authNetworkClient.mock.calls[call][0].proxy_config.initial_device_state.performance_profile;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
		h.api.authNetworkClient.mockImplementation(async () => provisioned("client-new"));
	});

	it("CONNECT provisions the hosted device with the page's Fixed IP window", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });

		const res = await app.request("CONNECT", { performanceProfile: FIXED_IP_WEB });

		expect(res.ok).toBe(true);
		expect(sentProfile(0)).toEqual(wireProfile("quality", wireWindow(1, 1)));
	});

	it("a popup location change with no ur.io tab open provisions with the same options", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });
		await app.request("CONNECT", { locationId: "location-1", performanceProfile: FIXED_IP_STREAMING });
		app.disconnectFromClient();

		await h.bridge.connectFromPopup({ connect_location_id: { location_id: "location-2" } } as never);

		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(2);
		expect(sentProfile(1)).toEqual(wireProfile("speed", wireWindow(1, 1)));
		expect(h.api.authNetworkClient.mock.calls[1][0].proxy_config.initial_device_state.location)
			.toMatchObject({ connect_location_id: { location_id: "location-2" } });
	});

	it("SET_PERFORMANCE_PROFILE keeps a change for the next client without reconnecting", async () => {
		const seed = await h.seedLiveSession();

		const res = await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: WEB });

		expect(res).toMatchObject({ ok: true, data: { stored: true } });
		// zero disruption: the live session is the page's to change, over the device-rpc
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
		expect(h.chrome.alarmClearCalls).toHaveLength(0);
		expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);

		// the next client, at another location, starts with the change
		await app.request("CONNECT", { locationId: "location-9" });
		expect(sentProfile(0)).toEqual(wireProfile("quality", wireWindow(2, 4)));
	});

	it("a SET_LOCATION connect right after a change provisions with the change", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });

		// sent back to back, as the page does when an option and a pick land together
		const [stored, connected] = await Promise.all([
			app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: FIXED_IP_WEB }),
			app.request("SET_LOCATION", { locationId: "location-1", name: "Somewhere" }),
		]);

		expect(stored.ok).toBe(true);
		expect(connected).toMatchObject({ ok: true, data: { applied: "connected" } });
		expect(sentProfile(0)).toEqual(wireProfile("quality", wireWindow(1, 1)));
	});

	it("a CONNECT from an older page provisions with the kept options, else auto", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });

		await app.request("CONNECT");
		expect(sentProfile(0)).toBeNull();

		// each new client (here, at a new location) starts with the kept options
		await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: FIXED_IP_WEB });
		await app.request("CONNECT", { locationId: "location-1" });
		expect(sentProfile(1)).toEqual(wireProfile("quality", wireWindow(1, 1)));

		// Auto is a choice too: the page's auto replaces the kept Fixed IP
		await app.request("CONNECT", { locationId: "location-2", performanceProfile: AUTO });
		expect(sentProfile(2)).toEqual(wireProfile("auto", null));

		// the saved client at its own location is reused: no new provision
		await app.request("CONNECT", { locationId: "location-2" });
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(3);
	});

	it("refuses invalid options before anything changes", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });
		await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: FIXED_IP_WEB });
		h.chrome.resetCalls();

		const inverted = { ...FIXED_IP_WEB, windowSize: { windowSizeMin: 4, windowSizeMax: 1 } };
		const connect = await app.request("CONNECT", { performanceProfile: inverted });
		const set = await app.request("SET_PERFORMANCE_PROFILE", {
			performanceProfile: { ...WEB, windowType: "bogus" },
		});
		const missing = await app.request("SET_PERFORMANCE_PROFILE", {});

		for (const res of [connect, set, missing]) {
			expect(res).toMatchObject({ ok: false, error: "Invalid performance profile" });
		}
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);

		// the kept options are untouched
		await app.request("CONNECT");
		expect(sentProfile(0)).toEqual(wireProfile("quality", wireWindow(1, 1)));
	});

	it("never provisions one network with the options kept for another", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });
		await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: FIXED_IP_WEB });

		await app.request("SETUP", { jwt: makeJwt({ network_id: OTHER_NETWORK_ID }) });
		await app.request("CONNECT");

		expect(sentProfile(0)).toBeNull();
	});

	it("keeps nothing while the extension holds no identity", async () => {
		const res = await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: FIXED_IP_WEB });

		expect(res).toMatchObject({ ok: true, data: { stored: false } });
		expect(h.chrome.getStored("connect_performance_profile")).toBeUndefined();
	});
});
