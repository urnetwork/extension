// The connect options over the bridge: CONNECT may carry the page's profile,
// SET_PERFORMANCE_PROFILE hands over a change, and every session the
// extension provisions starts with the last one, renewals included. A hosted
// device recreated with no ur.io tab open starts from that provisioning, so
// before this it ran in Auto (rotating exits) whatever Fixed IP said.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBridgeHarness,
	makeJwt,
	NETWORK_ID,
	OTHER_NETWORK_ID,
	RENEW_ALARM,
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

	const renew = async (calls: number) => {
		for (const listener of h.chrome.onAlarmListeners) {
			listener({ name: RENEW_ALARM, scheduledTime: Date.now() });
		}
		await vi.waitFor(() => expect(h.api.authNetworkClient).toHaveBeenCalledTimes(calls));
	};

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

	it("a renewal with no ur.io tab open provisions with the same options", async () => {
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });
		await app.request("CONNECT", { locationId: "location-1", performanceProfile: FIXED_IP_STREAMING });
		app.disconnectFromClient();

		await renew(2);

		expect(sentProfile(1)).toEqual(wireProfile("speed", wireWindow(1, 1)));
		expect(h.api.authNetworkClient.mock.calls[1][0].proxy_config.initial_device_state.location)
			.toMatchObject({ connect_location_id: { location_id: "location-1" } });
	});

	it("SET_PERFORMANCE_PROFILE keeps a change for the next session without reconnecting", async () => {
		const seed = await h.seedLiveSession();

		const res = await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: WEB });

		expect(res).toMatchObject({ ok: true, data: { stored: true } });
		// zero disruption: the live session is the page's to change, over the device-rpc
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
		expect(h.chrome.alarmClearCalls).toHaveLength(0);
		expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);

		await renew(1);
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

		await app.request("SET_PERFORMANCE_PROFILE", { performanceProfile: FIXED_IP_WEB });
		await app.request("CONNECT");
		expect(sentProfile(1)).toEqual(wireProfile("quality", wireWindow(1, 1)));

		// Auto is a choice too: the page's auto replaces the kept Fixed IP
		await app.request("CONNECT", { performanceProfile: AUTO });
		expect(sentProfile(2)).toEqual(wireProfile("auto", null));
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
