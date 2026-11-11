// Releasing the proxy setting (B1, owner approval 2026-11-11). A disconnect,
// a logout and the health check's fallback set Chromium's proxy to "direct"
// (proxyManager.disable), which is a value of the extension's own: it kept
// overriding whatever the browser had under it, a system or corporate proxy
// included, until the extension was removed. They now clear the setting
// (chrome.proxy.settings.clear), and the browser's own settings apply again.
// Firefox sets no proxy setting (its listener answers per request), so
// removing the listener is its release, as it was.
//
// An older version's disconnect left that "direct" in place; a start with no
// connect intended releases it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { installChromeMock, SYSTEM_PROXY } from "./chrome-mock";
import { minuteSchedule } from "./health-schedule";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });

function provisioned(n: number) {
	return {
		by_client_jwt: makeJwt({ client_id: `client-${n}` }),
		proxy_config_result: {
			auth_token: `SIGNED${n}`,
			instance_id: `aaaaaaaa-bbbb-cccc-dddd-${n.toString(16).padStart(12, "0")}`,
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
		},
	};
}

describe("taking the proxy off releases the browser's setting", () => {
	let h: BridgeHarness;

	beforeEach(async () => {
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: JWT, network_name: "testnet" });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
	});

	afterEach(() => {
		delete (globalThis as { browser?: unknown }).browser;
	});

	// the browser's own setting is in effect again, and nothing of the extension's
	function expectReleased() {
		expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
		expect(h.chrome.ownProxyValue()).toBeNull();
		expect(h.chrome.levelOfControl()).toBe("controllable_by_this_extension");
		expect(h.chrome.proxySettingsSetCalls).not.toContainEqual(
			expect.objectContaining({ value: { mode: "direct" } }),
		);
	}

	it("a disconnect", async () => {
		await h.bridge.connectFromPopup(undefined);
		expect(h.chrome.levelOfControl()).toBe("controlled_by_this_extension");

		await h.bridge.disconnectFromPopup();

		expectReleased();
		expect(h.chrome.proxySettingsClearCalls).toEqual([{ scope: "regular" }]);
	});

	it("a logout", async () => {
		await h.bridge.connectFromPopup(undefined);

		await h.bridge.endFromPopup();

		expectReleased();
	});

	it("the health check's fallback with the kill switch off", async () => {
		await h.bridge.connectFromPopup(undefined);
		const health = await import("../src/utils/proxy-health");
		const schedule = minuteSchedule(health);

		// tests/setup.ts fails every fetch: the proxy does not answer
		for (let i = 0; i < 3; i++) await schedule.check();

		expect(h.chrome.getStored("proxy_health_report")).toBe("fell_back");
		expectReleased();
	});

	it("Firefox: the listener goes, and no proxy setting is touched", async () => {
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

		await h.bridge.disconnectFromPopup();

		expect(listeners).toHaveLength(0);
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
		expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
	});
});

describe("a start after an older version's disconnect", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("releases the 'direct' it left, when no connect is intended", async () => {
		const mock = installChromeMock();
		mock.setProxyValue({ mode: "direct" });
		mock.seedStorage({ proxy_enabled: false, proxy_config: null });
		const { proxyManager } = await import("../src/utils/proxy-manager");

		await proxyManager.restoreState();

		expect(mock.proxyValue()).toEqual(SYSTEM_PROXY);
		expect(mock.ownProxyValue()).toBeNull();
	});

	it("applies the saved proxy over it, when a connect is intended", async () => {
		const mock = installChromeMock();
		const config = { host: "SIGNED1.proxy.example.ur", port: 8443, scheme: "https" as const };
		mock.setProxyValue({ mode: "direct" });
		mock.seedStorage({ proxy_enabled: true, proxy_config: config });
		const { proxyManager } = await import("../src/utils/proxy-manager");

		await proxyManager.restoreState();

		expect(mock.proxyValue()).toMatchObject({ mode: "fixed_servers", rules: { singleProxy: config } });
	});
});
