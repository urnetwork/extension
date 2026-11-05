// The install's one hosted proxy client through the popup's requests, the
// background's health check and an upgrade from the multi-IP pool. Driven
// through the bridge module's popup entry points (what background/index.ts
// POPUP_* call) and the health check, with the chrome mock as the browser.
//
// - kill switch off (the default): a proxy that fails three checks in a row is
//   taken off and the browser goes direct; the client stays saved and the
//   next connect applies it again with no auth-client call.
// - kill switch on: the proxy stays set (fail closed).
// - a popup location change with no ur.io tab replaces the client, removing
//   the old one before the connect answers; with a tab attached the tab moves
//   the hosted device and no client is provisioned.
// - logout removes the client.
// - an older version's PAC pool is replaced by one client and released.
// - Firefox gets the one proxy from its onRequest listener.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBridgeHarness,
	makeJwt,
	NETWORK_ID,
	type BridgeHarness,
} from "./harness";
import type { ConnectLocation } from "../../src/utils/sdk-types";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });

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

const at = (locationId: string) =>
	({ connect_location_id: { location_id: locationId }, name: locationId }) as unknown as ConnectLocation;

type HealthModule = typeof import("../../src/utils/proxy-health");

describe("the one client's paths", () => {
	let h: BridgeHarness;
	let health: HealthModule;

	const provisions = () => h.api.authNetworkClient.mock.calls.length;
	const popupMessages = () =>
		h.chrome.runtimeMessages.filter((m) => (m as { type?: string }).type === "PROXY_HEALTH");

	beforeEach(async () => {
		h = await createBridgeHarness();
		// the same module registry as the bridge the harness loaded
		health = await import("../../src/utils/proxy-health");
		h.chrome.seedStorage({ by_jwt: JWT, network_name: "testnet" });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
	});

	afterEach(() => {
		delete (globalThis as { browser?: unknown }).browser;
	});

	describe("health check and kill switch", () => {
		it("kill switch off: three failed checks go direct and the next connect reuses the client", async () => {
			await h.bridge.connectFromPopup(undefined);
			// tests/setup.ts fails every fetch: the proxy does not answer

			expect(await health.performHealthCheck()).toBe("failing");
			expect(await health.performHealthCheck()).toBe("failing");
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
			const notify = vi.fn();
			expect(await health.performHealthCheck(notify)).toBe("fell_back");

			expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
			expect(notify).toHaveBeenCalledWith("health");
			expect(popupMessages()).toEqual([{ type: "PROXY_HEALTH", outcome: "fell_back" }]);
			// the client stays saved
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
			expect(h.chrome.getStored("bridge_session")).toMatchObject({ clientId: clientId(1) });

			// reconnect
			const outcome = await h.bridge.connectFromPopup(undefined);
			expect(outcome.ok).toBe(true);
			expect(provisions()).toBe(1);
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
			// the connect started the count afresh: one failure is not a fallback yet
			expect(await health.performHealthCheck()).toBe("failing");
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
		});

		it("kill switch on: failed checks keep the proxy set", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await h.bridge.connectFromPopup(undefined);

			const outcomes = [];
			for (let i = 0; i < 5; i++) outcomes.push(await health.performHealthCheck());

			expect(outcomes).toEqual(["failing", "failing", "unreachable", "unreachable", "unreachable"]);
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
			expect(popupMessages()).toContainEqual({ type: "PROXY_HEALTH", outcome: "unreachable" });
		});

		it("a passing check starts the count afresh", async () => {
			await h.bridge.connectFromPopup(undefined);

			expect(await health.performHealthCheck()).toBe("failing");
			expect(await health.performHealthCheck()).toBe("failing");
			vi.stubGlobal("fetch", async () => ({ ok: true }));
			expect(await health.performHealthCheck()).toBe("healthy");
			vi.stubGlobal("fetch", async () => {
				throw new Error("unreachable");
			});
			expect(await health.performHealthCheck()).toBe("failing");
			expect(await health.performHealthCheck()).toBe("failing");

			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
			expect(popupMessages()).toEqual([{ type: "PROXY_HEALTH", outcome: "healthy" }]);
		});

		it("a disconnected browser is not checked", async () => {
			await h.bridge.connectFromPopup(undefined);
			await h.bridge.disconnectFromPopup();

			expect(await health.performHealthCheck()).toBe("idle");
			expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
		});
	});

	describe("location changes", () => {
		it("with no ur.io tab: the new client replaces the old before the connect answers", async () => {
			await h.bridge.connectFromPopup(at("location-1"));

			const outcome = await h.bridge.connectFromPopup(at("location-2"));

			expect(outcome.ok).toBe(true);
			expect(provisions()).toBe(2);
			expect(h.api.removeNetworkClient).toHaveBeenCalledTimes(1);
			expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
			expect(h.chrome.getStored("bridge_session")).toMatchObject({ clientId: clientId(2) });
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(2));
		});

		it("with a ur.io tab attached: the tab moves the hosted device and nothing is provisioned", async () => {
			await h.bridge.connectFromPopup(at("location-1"));
			const app = h.connect();

			const delegated = await h.bridge.handleExtensionLocationChange("location-2", "location-2");

			expect(delegated).toEqual({ delegated: true });
			expect(app.events).toContainEqual(
				expect.objectContaining({ event: "APPLY_LOCATION", payload: expect.objectContaining({ locationId: "location-2" }) }),
			);
			// the saved client runs at the new location now: connecting there reuses it
			const outcome = await h.bridge.connectFromPopup(at("location-2"));
			expect(outcome.ok).toBe(true);
			expect(provisions()).toBe(1);
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
		});

		it("with no ur.io tab the change is not delegated", async () => {
			await h.bridge.connectFromPopup(at("location-1"));

			expect(await h.bridge.handleExtensionLocationChange("location-2")).toEqual({ delegated: false });
		});
	});

	it("logout removes the client, and the next connect provisions anew", async () => {
		await h.bridge.connectFromPopup(undefined);

		const session = await h.bridge.endFromPopup();

		expect(session.connected).toBe(false);
		expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
		expect(h.chrome.getStored("bridge_session")).toBeUndefined();
		await h.bridge.connectFromPopup(undefined);
		expect(provisions()).toBe(2);
	});

	describe("an older version's multi-IP pool", () => {
		it("a connected pool is replaced by one client at the popup's pick, and released", async () => {
			h.chrome.seedStorage({
				multi_ip_client_ids: JSON.stringify(["pool-client-1", "pool-client-2"]),
				multi_ip_slots: JSON.stringify([{ host: "SIGNEDP.proxy.example.ur", port: 8443 }]),
				proxy_enabled: true,
				selected_connect_location: JSON.stringify(at("location-1")),
			});
			h.chrome.setProxyValue({ mode: "pac_script", pacScript: { url: "data:application/x-ns-proxy-autoconfig;base64,AA==" } });

			await h.bridge.migrateLegacyMultiIp();

			expect(provisions()).toBe(1);
			expect(
				h.api.authNetworkClient.mock.calls[0][0].proxy_config.initial_device_state.location,
			).toMatchObject({ connect_location_id: { location_id: "location-1" } });
			expect(h.chrome.proxyValue()).toMatchObject(fixedProxy(1));
			expect(h.api.removeNetworkClient).toHaveBeenCalledWith("pool-client-1", JWT);
			expect(h.api.removeNetworkClient).toHaveBeenCalledWith("pool-client-2", JWT);
			expect(h.chrome.getStored("multi_ip_client_ids")).toBeUndefined();
			expect(h.chrome.getStored("multi_ip_slots")).toBeUndefined();
		});

		it("a disconnected pool's clients are released and nothing is provisioned", async () => {
			h.chrome.seedStorage({ multi_ip_client_ids: JSON.stringify(["pool-client-1"]) });

			await h.bridge.migrateLegacyMultiIp();

			expect(provisions()).toBe(0);
			expect(h.api.removeNetworkClient).toHaveBeenCalledWith("pool-client-1", JWT);
			expect(h.chrome.getStored("multi_ip_client_ids")).toBeUndefined();
		});

		it("with no pool, an upgrade does nothing", async () => {
			await h.bridge.migrateLegacyMultiIp();

			expect(provisions()).toBe(0);
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
		});
	});

	it("Firefox: one listener answers with the one proxy, and a reconnect reuses the client", async () => {
		const listeners: Array<(details: { url: string }) => unknown> = [];
		(globalThis as { browser?: unknown }).browser = {
			proxy: {
				onRequest: {
					addListener: (listener: (details: { url: string }) => unknown) => listeners.push(listener),
					removeListener: (listener: (details: { url: string }) => unknown) => {
						const index = listeners.indexOf(listener);
						if (0 <= index) listeners.splice(index, 1);
					},
					hasListener: (listener: (details: { url: string }) => unknown) => listeners.includes(listener),
				},
			},
		};

		await h.bridge.connectFromPopup(undefined);

		expect(listeners).toHaveLength(1);
		const proxy = { type: "https", host: "SIGNED1.proxy.example.ur", port: 8443, failoverTimeout: 5 };
		// the kill switch is off by default: a request may fail over to direct
		expect(listeners[0]({ url: "https://example.com/" })).toEqual([proxy, { type: "direct" }]);

		await h.bridge.disconnectFromPopup();
		expect(listeners).toHaveLength(0);
		await h.bridge.connectFromPopup(undefined);
		expect(listeners).toHaveLength(1);
		expect(provisions()).toBe(1);
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
	});
});
