// Baseline verb-dispatch contract of the bridge. Not exhaustive per-verb
// coverage (each verb earns its own file as it grows tests — see
// refresh-jwt.test.ts); this pins the dispatch behaviors every page-side
// caller relies on.
import { beforeEach, describe, expect, it } from "vitest";
import { createBridgeHarness, type BridgeHarness, type FakePort } from "./harness";
import { makeJwt, NETWORK_ID } from "./harness";

describe("bridge verb dispatch", () => {
	let h: BridgeHarness;
	let app: FakePort;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
	});

	it("PING answers with the extension version", async () => {
		const res = await app.request("PING");
		expect(res.ok).toBe(true);
		expect(res.data).toEqual({ version: "0.0.0-test" });
	});

	it("an unknown verb is an explicit error frame, not silence", async () => {
		// the page's capability detection depends on this: an older extension
		// must answer `ok:false` with an unknown-verb error (so e.g. REFRESH_JWT
		// support can be probed and fallen back from), never leave the request
		// hanging or pretend success
		const res = await app.request("FROBNICATE");
		expect(res.ok).toBe(false);
		expect(res.error).toBe("Unknown verb: FROBNICATE");
		expect(res.id).toBeDefined();
	});

	it("GET_STATUS reports no user and no session on a cold extension", async () => {
		const res = await app.request("GET_STATUS");
		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({
			version: "0.0.0-test",
			user: null,
			session: { connected: false },
		});
	});

	it("GET_STATUS preserves the device session when Chrome lowercases the proxy hostname", async () => {
		const { record } = await h.seedLiveSession();
		const signedProxyId = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
		const configuredHost = `${signedProxyId}.${record.proxyHost}`;
		h.chrome.seedStorage({
			bridge_session: { ...record, signedProxyId },
			proxy_config: {
				host: configuredHost,
				port: record.httpsProxyPort,
				scheme: "https",
			},
		});
		h.chrome.setProxyValue({
			mode: "fixed_servers",
			rules: {
				singleProxy: {
					scheme: "https",
					host: configuredHost.toLowerCase(),
					port: record.httpsProxyPort,
				},
			},
		});

		const res = await app.request("GET_STATUS");

		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({
			session: {
				connected: true,
				instanceId: record.instanceId,
			},
		});
		expect(JSON.stringify(res.data)).not.toContain(signedProxyId);
		expect(JSON.stringify(res.data)).not.toContain(record.apiBaseUrl);
	});

	it("GET_STATUS does not advertise a device for a stale proxy port", async () => {
		const { record } = await h.seedLiveSession();
		h.chrome.setProxyValue({
			mode: "fixed_servers",
			rules: {
				singleProxy: {
					scheme: "https",
					host: `${record.signedProxyId}.${record.proxyHost}`,
					port: record.httpsProxyPort + 1,
				},
			},
		});

		const res = await app.request("GET_STATUS");

		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({
			session: { connected: true, instanceId: null },
		});
	});

	it("a disconnected page port stops counting as an attached app", async () => {
		expect(h.bridge.hasConnectedApp()).toBe(true);
		app.disconnectFromClient();
		expect(h.bridge.hasConnectedApp()).toBe(false);
	});

	it("CONNECT persists and reports the server-issued hosted instance", async () => {
		const jwt = makeJwt({ network_id: NETWORK_ID, network_name: "testnet" });
		await app.request("SETUP", { jwt });
		h.api.authNetworkClient.mockResolvedValueOnce({
			by_client_jwt: makeJwt({ client_id: "client-new" }),
			proxy_config_result: {
				auth_token: "signed-proxy",
				instance_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				proxy_host: "proxy.example.ur",
				https_proxy_port: 8443,
				api_base_url: "https://api.proxy.example.ur:8444",
			},
		});

		const res = await app.request("CONNECT");

		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({
			session: {
				connected: true,
				instanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			},
		});
		expect(h.chrome.getStored("bridge_session")).toMatchObject({
			instanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		});
	});

	it("CONNECT rejects a proxy response without the hosted instance", async () => {
		const jwt = makeJwt({ network_id: NETWORK_ID });
		await app.request("SETUP", { jwt });
		h.chrome.resetCalls();
		h.api.authNetworkClient.mockResolvedValueOnce({
			by_client_jwt: makeJwt({ client_id: "client-new" }),
			proxy_config_result: {
				auth_token: "signed-proxy",
				proxy_host: "proxy.example.ur",
				https_proxy_port: 8443,
				api_base_url: "https://api.proxy.example.ur:8444",
			},
		});

		const res = await app.request("CONNECT");

		expect(res.ok).toBe(false);
		expect(res.code).toBe("incomplete_config");
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
	});

	it("CONNECT rejects a proxy response without an extension-owned RPC endpoint", async () => {
		const jwt = makeJwt({ network_id: NETWORK_ID });
		await app.request("SETUP", { jwt });
		h.chrome.resetCalls();
		h.api.authNetworkClient.mockResolvedValueOnce({
			by_client_jwt: makeJwt({ client_id: "client-new" }),
			proxy_config_result: {
				auth_token: "signed-proxy",
				instance_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				proxy_host: "proxy.example.ur",
				https_proxy_port: 8443,
			},
		});

		const res = await app.request("CONNECT");

		expect(res.ok).toBe(false);
		expect(res.code).toBe("incomplete_config");
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
	});
});
