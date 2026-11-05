import { afterEach, describe, expect, it, vi } from "vitest";
import { chromeBypassList, deviceRpcApiHost, shouldBypass } from "../src/utils/bypass-rules";
import { installChromeMock } from "./chrome-mock";

const PROXY_CONFIG = {
	host: "SIGNED.proxy.example.ur",
	port: 8443,
	scheme: "https" as const,
};

afterEach(() => {
	delete (globalThis as { browser?: unknown }).browser;
});

describe("device-rpc control-host bypass", () => {
	it("derives and bypasses only the exact control host", () => {
		const apiHost = deviceRpcApiHost(PROXY_CONFIG.host);
		expect(apiHost).toBe("api.proxy.example.ur");
		expect(shouldBypass("api.proxy.example.ur", [apiHost!])).toBe(true);
		expect(shouldBypass("api-v4.proxy.example.ur", [apiHost!])).toBe(false);
		expect(shouldBypass("attacker.api.proxy.example.ur", [apiHost!])).toBe(false);
		expect(chromeBypassList([apiHost!])).toContain("api.proxy.example.ur");
	});

	it("installs the dynamic bypass in Chromium fixed-proxy settings", async () => {
		vi.resetModules();
		const chromeMock = installChromeMock();
		const { proxyManager } = await import("../src/utils/proxy-manager");
		await proxyManager.enable(PROXY_CONFIG);
		const call = chromeMock.proxySettingsSetCalls[0] as {
			value: { rules: { bypassList: string[] } };
		};
		const value = call.value;
		expect(value.rules.bypassList).toContain("api.proxy.example.ur");
		expect(value.rules.bypassList).not.toContain("api-v4.proxy.example.ur");
	});

	// the one proxy for every request; the kill switch (off by default, owner
	// 2026-10-02) decides whether a request may fail over to direct
	it("returns DIRECT for the control host and the one proxy for api-v4 in Firefox", async () => {
		const proxy = { type: "https", host: PROXY_CONFIG.host, port: 8443, failoverTimeout: 5 };
		for (const killSwitch of [undefined, false, true]) {
			vi.resetModules();
			const chromeMock = installChromeMock();
			if (killSwitch !== undefined) {
				chromeMock.seedStorage({ kill_switch_enabled: killSwitch });
			}
			const listeners: Array<(details: { url: string }) => unknown> = [];
			const onRequest = {
				addListener: (listener: (details: { url: string }) => unknown) => listeners.push(listener),
				removeListener: (listener: (details: { url: string }) => unknown) => {
					const index = listeners.indexOf(listener);
					if (0 <= index) listeners.splice(index, 1);
				},
				hasListener: (listener: (details: { url: string }) => unknown) => listeners.includes(listener),
			};
			(globalThis as { browser?: unknown }).browser = { proxy: { onRequest } };
			const { proxyManager } = await import("../src/utils/proxy-manager");
			await proxyManager.loadKillSwitch();
			await proxyManager.enable(PROXY_CONFIG);
			expect(listeners).toHaveLength(1);
			expect(listeners[0]({ url: "wss://api.proxy.example.ur:8444/device-rpc" })).toEqual([{ type: "direct" }]);
			expect(listeners[0]({ url: "https://api-v4.proxy.example.ur/data" })).toEqual(
				killSwitch === true ? [proxy] : [proxy, { type: "direct" }],
			);
		}
	});
});
