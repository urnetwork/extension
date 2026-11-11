// One hosted proxy client per extension install (owner, 2026-11-05). The first
// connect provisions it; a connect after a disconnect, a cold service worker
// reattaching, and an older version's renewal alarm all reuse it with no
// auth-client call, and the browser gets it as one fixed proxy. A connect at
// another location replaces it, removing the old client before it answers, so
// one stays active. Before, every connect and every renewal provisioned a new
// client, a disconnect removed it, and a replaced client was removed some time
// after the connect answered.
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
import { SYSTEM_PROXY } from "../chrome-mock";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });

// a synthetic client id, distinct for each n
function clientId(n: number): string {
	return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

// the n-th client the server provisions
function provisioned(n: number) {
	return {
		by_client_jwt: makeJwt({ client_id: clientId(n) }),
		proxy_config_result: {
			auth_token: `SIGNED${n}`,
			instance_id: `aaaaaaaa-bbbb-cccc-dddd-${n.toString(16).padStart(12, "0")}`,
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
		},
	};
}

// the browser's proxy settings for the n-th client
const fixedProxy = (n: number) => ({
	mode: "fixed_servers",
	rules: { singleProxy: { scheme: "https", host: `SIGNED${n}.proxy.example.ur`, port: 8443 } },
});

describe("one hosted proxy client per install", () => {
	let h: BridgeHarness;
	let app: FakePort;

	const provisions = () => h.api.authNetworkClient.mock.calls.length;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
		await app.request("SETUP", { jwt: JWT });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
		h.chrome.resetCalls();
	});

	it("the first connect provisions one client and gives the browser one fixed proxy", async () => {
		const res = await app.request("CONNECT");

		expect(res.ok).toBe(true);
		expect(provisions()).toBe(1);
		const value = h.chrome.proxyValue() as { rules: { bypassList: string[] } };
		expect(value).toMatchObject(fixedProxy(1));
		// the api and the hosted device's own device-rpc host stay direct
		expect(value.rules.bypassList).toEqual(
			expect.arrayContaining(["api.bringyour.com", "api.proxy.example.ur"]),
		);
	});

	it("disconnect and connect again reuse the client", async () => {
		await app.request("CONNECT");

		for (let i = 0; i < 3; i++) {
			const off = await app.request("DISCONNECT");
			expect(off).toMatchObject({ ok: true, data: { session: { connected: false } } });
			expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
			const on = await app.request("CONNECT");
			expect(on).toMatchObject({ ok: true, data: { session: { connected: true, clientId: clientId(1) } } });
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
		}

		expect(provisions()).toBe(1);
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
	});

	it("a cold service worker reattaches to the saved client", async () => {
		await app.request("CONNECT");
		const saved = new Map(h.chrome.storageData);
		const proxy = h.chrome.proxyValue();

		// the browser restarts the worker: fresh modules, the same storage and proxy
		h = await createBridgeHarness();
		for (const [key, value] of saved) h.chrome.storageData.set(key, value);
		h.chrome.setProxyValue(proxy);
		app = h.connect();

		const session = await app.request("GET_SESSION");
		expect(session).toMatchObject({
			ok: true,
			data: { session: { connected: true, clientId: clientId(1) } },
		});
		const res = await app.request("CONNECT");
		expect(res.ok).toBe(true);
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
	});

	it("an older version's renewal alarm provisions nothing", async () => {
		await app.request("CONNECT");
		h.chrome.alarms.set(RENEW_ALARM, { when: Date.now() });

		for (const listener of h.chrome.onAlarmListeners) {
			listener({ name: RENEW_ALARM, scheduledTime: Date.now() });
		}

		await vi.waitFor(() => expect(h.chrome.alarms.has(RENEW_ALARM)).toBe(false));
		expect(provisions()).toBe(1);
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
	});

	it("a connect at another location replaces the client before it answers", async () => {
		await app.request("CONNECT", { locationId: "location-1" });

		const res = await app.request("CONNECT", { locationId: "location-2" });

		expect(res.ok).toBe(true);
		expect(provisions()).toBe(2);
		expect(
			h.api.authNetworkClient.mock.calls[1][0].proxy_config.initial_device_state.location,
		).toMatchObject({ connect_location_id: { location_id: "location-2" } });
		// one active client: the replaced one is already removed
		expect(h.api.removeNetworkClient).toHaveBeenCalledTimes(1);
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
		expect(h.chrome.getStored("bridge_session")).toMatchObject({
			clientId: clientId(2),
			locationId: "location-2",
		});
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(2));

		// connecting there again reuses it
		await app.request("DISCONNECT");
		await app.request("CONNECT", { locationId: "location-2" });
		expect(provisions()).toBe(2);
		expect(h.api.removeNetworkClient).toHaveBeenCalledTimes(1);
	});

	it("setup with another identity removes the client, and the next connect provisions anew", async () => {
		await app.request("CONNECT");

		await app.request("SETUP", { jwt: makeJwt({ network_id: OTHER_NETWORK_ID }) });

		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
		expect(h.chrome.getStored("bridge_session")).toBeUndefined();
		expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
		await app.request("CONNECT");
		expect(provisions()).toBe(2);
	});

	it("a client provisioned with an incomplete config is released", async () => {
		h.api.authNetworkClient.mockImplementationOnce(async () => ({
			by_client_jwt: makeJwt({ client_id: clientId(9) }),
			proxy_config_result: { auth_token: "SIGNED9", proxy_host: "proxy.example.ur", https_proxy_port: 8443 },
		}));

		const res = await app.request("CONNECT");

		expect(res).toMatchObject({ ok: false, code: "incomplete_config" });
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(9), JWT);
		expect(h.chrome.getStored("bridge_session")).toBeUndefined();
	});
});
