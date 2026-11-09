// The install's one hosted proxy client against the network's active proxy
// cap (free 5, Pro 1000) and against the server removing it (support inbox
// 8244: a free network held 5 hosted proxies, 4 of them left by extension
// installs that no longer used them, and the way out is to remove proxies on
// ur.io's Proxies page).
//
// - A connect at another location replaces the client: it provisions the new
//   one before it removes the old, so it needs one more proxy than the
//   network holds for a moment. At the cap the server refused that create and
//   the connect failed, though the install would still hold one client; an
//   older version's pool of 5 filled the free cap by itself, so its upgrade
//   never connected. Now the install gives its own clients back and creates
//   the replacement in their slot, with the browser never going direct in
//   between. A network at the cap with no client of this install's is
//   refused. A retry refused again leaves the browser off the proxy, unless
//   the kill switch keeps it set.
// - A saved client the server no longer has (removed on ur.io, trimmed, or
//   idle 30 days) was applied again on every connect, and the browser went
//   direct three failed checks later, for good. Now a connect after the health
//   check gave up on the client asks the server for the network's proxies, and
//   provisions anew when the client is not among them. A connect with no
//   failure before it asks nothing.
import { beforeEach, describe, expect, it } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness, type FakePort } from "./harness";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });

const CAP_MESSAGE =
	"Your plan's limit of 5 active proxies is reached. Remove a proxy to create another, or upgrade to UR Pro for more.";

function clientId(n: number): string {
	return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

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

const fixedProxy = (n: number) => ({
	mode: "fixed_servers",
	rules: { singleProxy: { scheme: "https", host: `SIGNED${n}.proxy.example.ur`, port: 8443 } },
});

type HealthModule = typeof import("../../src/utils/proxy-health");

describe("the install's client at the proxy cap and after the server removed it", () => {
	let h: BridgeHarness;
	let app: FakePort;
	let health: HealthModule;
	// the network's active hosted proxies on the fake server
	let active: Set<string>;

	const provisions = () => h.api.authNetworkClient.mock.calls.length;

	// auth-client and remove-client over `active`, refusing a create at `cap`
	// as auth-client does (bridge/api.ts passes the refusal through)
	function serveNetwork(cap: number, others: string[]): void {
		active = new Set(others);
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => {
			if (cap <= active.size) {
				return {
					proxy_config_result: null,
					error: { message: CAP_MESSAGE, client_limit_exceeded: true, upgrade_required: true },
				};
			}
			const n = next++;
			active.add(clientId(n));
			return provisioned(n);
		});
		h.api.removeNetworkClient.mockImplementation(async (id: string) => {
			active.delete(id);
			return true;
		});
		h.api.activeProxyClientIds.mockImplementation(async () => new Set(active));
	}

	// tests/setup.ts fails every fetch, so each check fails; the third takes the
	// proxy off (kill switch off)
	async function failHealthChecks(): Promise<void> {
		for (let i = 0; i < 3; i++) await health.performHealthCheck();
		expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
	}

	beforeEach(async () => {
		h = await createBridgeHarness();
		health = await import("../../src/utils/proxy-health");
		app = h.connect();
		await app.request("SETUP", { jwt: JWT });
		h.chrome.resetCalls();
	});

	it("a location change at the cap gives the install's own client back for its replacement", async () => {
		const others = ["other-1", "other-2", "other-3", "other-4"];
		serveNetwork(5, others);
		await app.request("CONNECT", { locationId: "location-1" });
		expect(active.size).toBe(5);

		const res = await app.request("CONNECT", { locationId: "location-2" });

		expect(res).toMatchObject({ ok: true, data: { session: { connected: true, clientId: clientId(2) } } });
		// the refused create, then the replacement in the slot the install gave back
		expect(provisions()).toBe(3);
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
		expect(active).toEqual(new Set([...others, clientId(2)]));
		expect(h.chrome.getStored("bridge_session")).toMatchObject({
			clientId: clientId(2),
			locationId: "location-2",
		});
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(2));
		// the browser went from the old proxy to the new one, never direct
		const settings = h.chrome.proxySettingsSetCalls.map((call) => {
			const value = (call as { value: { mode: string; rules?: { singleProxy?: { host?: string } } } }).value;
			return value.rules?.singleProxy?.host ?? value.mode;
		});
		expect(settings).toEqual(["SIGNED1.proxy.example.ur", "SIGNED2.proxy.example.ur"]);
	});

	it("a replacement refused again after the give-back leaves the browser off the proxy with the server's words", async () => {
		serveNetwork(5, ["other-1", "other-2", "other-3", "other-4"]);
		await app.request("CONNECT", { locationId: "location-1" });
		const RATE_MESSAGE = "Your plan allows 5 new proxies a minute. Try again in a minute, or upgrade to UR Pro for more.";
		h.api.authNetworkClient.mockImplementation(async () => ({
			proxy_config_result: null,
			error: { message: RATE_MESSAGE, client_limit_exceeded: true, upgrade_required: true },
		}));

		const res = await app.request("CONNECT", { locationId: "location-2" });

		expect(res).toMatchObject({ ok: false, error: RATE_MESSAGE, code: "upgrade_required" });
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
		expect(h.chrome.getStored("bridge_session")).toBeUndefined();
		expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
		expect(app.events).toContainEqual(
			expect.objectContaining({ event: "SESSION_CHANGED", payload: expect.objectContaining({ reason: "disconnect" }) }),
		);
	});

	it("with the kill switch on, a replacement refused again keeps the browser on the proxy setting", async () => {
		h.chrome.seedStorage({ kill_switch_enabled: true });
		serveNetwork(5, ["other-1", "other-2", "other-3", "other-4"]);
		await app.request("CONNECT", { locationId: "location-1" });
		h.api.authNetworkClient.mockImplementation(async () => ({
			proxy_config_result: null,
			error: { message: CAP_MESSAGE, client_limit_exceeded: true, upgrade_required: true },
		}));

		const res = await app.request("CONNECT", { locationId: "location-2" });

		expect(res).toMatchObject({ ok: false, code: "upgrade_required" });
		// fail closed: nothing goes direct
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
	});

	it("an older version's pool of 5 at the free cap is given back for the one client", async () => {
		const pool = ["pool-client-1", "pool-client-2", "pool-client-3", "pool-client-4", "pool-client-5"];
		serveNetwork(5, pool);
		h.chrome.seedStorage({
			multi_ip_client_ids: JSON.stringify(pool),
			multi_ip_slots: JSON.stringify([{ host: "SIGNEDP.proxy.example.ur", port: 8443 }]),
			proxy_enabled: true,
		});
		h.chrome.setProxyValue({ mode: "pac_script", pacScript: { url: "data:application/x-ns-proxy-autoconfig;base64,AA==" } });

		await h.bridge.migrateLegacyMultiIp();

		expect(provisions()).toBe(2);
		for (const id of pool) expect(h.api.removeNetworkClient).toHaveBeenCalledWith(id, JWT);
		expect(active).toEqual(new Set([clientId(1)]));
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
		expect(h.chrome.getStored("multi_ip_client_ids")).toBeUndefined();
		expect(h.chrome.getStored("bridge_session")).toMatchObject({ clientId: clientId(1) });
	});

	it("a network at the cap with no client of this install's is refused with the server's words", async () => {
		const others = ["other-1", "other-2", "other-3", "other-4", "other-5"];
		serveNetwork(5, others);

		const res = await app.request("CONNECT");

		expect(res).toMatchObject({ ok: false, error: CAP_MESSAGE, code: "upgrade_required" });
		expect(provisions()).toBe(1);
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
		expect(active).toEqual(new Set(others));
		expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
	});

	it("a connect after the checks gave up provisions anew when the server no longer has the client", async () => {
		serveNetwork(5, []);
		await app.request("CONNECT");
		// removed on the server: ur.io's Proxies page, a trim, or the idle reap
		active.delete(clientId(1));
		await failHealthChecks();

		const res = await app.request("CONNECT");

		expect(res).toMatchObject({ ok: true, data: { session: { connected: true, clientId: clientId(2) } } });
		expect(provisions()).toBe(2);
		expect(h.api.activeProxyClientIds).toHaveBeenCalledTimes(1);
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(2));
		expect(h.chrome.getStored("bridge_session")).toMatchObject({ clientId: clientId(2) });

		// the new client is the install's: a disconnect and connect reuse it and ask nothing
		await app.request("DISCONNECT");
		await app.request("CONNECT");
		expect(provisions()).toBe(2);
		expect(h.api.activeProxyClientIds).toHaveBeenCalledTimes(1);
	});

	it("a connect after the checks gave up reuses the client the server still has", async () => {
		serveNetwork(5, []);
		await app.request("CONNECT");
		await failHealthChecks();

		const res = await app.request("CONNECT");

		expect(res).toMatchObject({ ok: true, data: { session: { connected: true, clientId: clientId(1) } } });
		expect(provisions()).toBe(1);
		expect(h.api.activeProxyClientIds).toHaveBeenCalledTimes(1);
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));

		// the server answered for it: the next connect asks nothing
		await app.request("DISCONNECT");
		await app.request("CONNECT");
		expect(h.api.activeProxyClientIds).toHaveBeenCalledTimes(1);
	});

	it("a connect after the checks gave up reuses the client when the list does not come back, and asks again next time", async () => {
		serveNetwork(5, []);
		h.api.activeProxyClientIds.mockImplementation(async () => null);
		await app.request("CONNECT");
		await failHealthChecks();

		await app.request("CONNECT");
		expect(provisions()).toBe(1);
		expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));

		await app.request("DISCONNECT");
		await app.request("CONNECT");
		expect(provisions()).toBe(1);
		expect(h.api.activeProxyClientIds).toHaveBeenCalledTimes(2);
	});

	it("a reconnect with no failed check asks the server nothing", async () => {
		serveNetwork(5, []);
		await app.request("CONNECT");

		for (let i = 0; i < 3; i++) {
			await app.request("DISCONNECT");
			await app.request("CONNECT");
		}

		expect(provisions()).toBe(1);
		expect(h.api.activeProxyClientIds).not.toHaveBeenCalled();
	});
});
