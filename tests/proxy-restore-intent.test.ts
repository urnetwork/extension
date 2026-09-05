import { afterEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";

const CONFIG = {
	host: "saved-specific.proxy.example.ur",
	port: 8443,
	scheme: "https" as const,
};

// Actual ProxyManager and browser-storage boundary; failures are delivered at
// the browser API operation, not by substituting a restore implementation.
afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as { browser?: unknown }).browser;
});

function installFirefox() {
	const listeners: Array<(details: { url: string }) => unknown> = [];
	const onRequest = {
		addListener: (listener: (details: { url: string }) => unknown) => {
			listeners.push(listener);
		},
		removeListener: (listener: (details: { url: string }) => unknown) => {
			const index = listeners.indexOf(listener);
			if (index >= 0) listeners.splice(index, 1);
		},
		hasListener: (listener: (details: { url: string }) => unknown) => listeners.includes(listener),
	};
	(globalThis as { browser?: unknown }).browser = { proxy: { onRequest } };
	return { listeners, onRequest };
}

describe("proxy restart preserves intended connection", () => {
	it("keeps Chromium intent after a real settings failure and retries the exact saved proxy", async () => {
		vi.resetModules();
		const browser = installChromeMock();
		browser.seedStorage({ proxy_enabled: true, proxy_config: CONFIG });
		const { proxyManager } = await import("../src/utils/proxy-manager");
		const set = vi.spyOn(chrome.proxy.settings, "set").mockImplementation(
			(_details, callback?: () => void) => {
				Object.defineProperty(chrome.runtime, "lastError", {
					configurable: true,
					value: { message: "private-settings-error" },
				});
				try { callback?.(); }
				finally {
					Object.defineProperty(chrome.runtime, "lastError", { configurable: true, value: undefined });
				}
				return Promise.resolve();
			},
		);
		const error = await proxyManager.restoreState().then(() => null, (failure: unknown) => failure);
		expect(browser.getStored("proxy_enabled"), "restore failure erased saved connect intent").toBe(true);
		expect(browser.getStored("proxy_config")).toEqual(CONFIG);
		expect(error).toEqual(new Error("Failed to restore saved proxy config"));
		expect(proxyManager.getState().enabled).toBe(false);
		expect(browser.proxyValue()).toEqual({ mode: "system" });

		set.mockRestore();
		await proxyManager.restoreState();
		expect(proxyManager.getState()).toEqual({ enabled: true, mode: "fixed", config: CONFIG });
		expect(browser.proxySettingsSetCalls).toHaveLength(1);
		expect(browser.proxyValue()).toMatchObject({ mode: "fixed_servers", rules: { singleProxy: CONFIG } });
	});

	it("keeps Firefox fixed intent when listener installation fails and retries without an app command", async () => {
		vi.resetModules();
		const browser = installChromeMock();
		browser.seedStorage({ proxy_enabled: true, proxy_config: CONFIG });
		const firefox = installFirefox();
		const install = vi.spyOn(firefox.onRequest, "addListener").mockImplementation(() => {
			throw new Error("private-listener-error");
		});
		const { proxyManager } = await import("../src/utils/proxy-manager");
		const error = await proxyManager.restoreState().then(() => null, (failure: unknown) => failure);
		expect(browser.getStored("proxy_enabled"), "restore failure erased saved connect intent").toBe(true);
		expect(browser.getStored("proxy_config")).toEqual(CONFIG);
		expect(error).toEqual(new Error("Failed to restore saved Firefox proxy config"));
		expect(firefox.listeners).toHaveLength(0);
		expect(proxyManager.isListenerActive()).toBe(false);

		install.mockRestore();
		await proxyManager.restoreState();
		expect(firefox.listeners).toHaveLength(1);
		expect(proxyManager.isListenerActive()).toBe(true);
		expect(proxyManager.getState()).toEqual({ enabled: true, mode: "fixed", config: CONFIG });
	});

	it("keeps a malformed Firefox multi-IP record intact and does not silently fall back to fixed mode", async () => {
		vi.resetModules();
		const browser = installChromeMock();
		const malformed = "{private-malformed-slot-record";
		browser.seedStorage({ proxy_enabled: true, proxy_config: CONFIG, multi_ip_slots: malformed });
		const firefox = installFirefox();
		const { proxyManager } = await import("../src/utils/proxy-manager");
		const error = await proxyManager.restoreState().then(() => null, (failure: unknown) => failure);
		expect(browser.getStored("proxy_enabled"), "restore failure erased saved connect intent").toBe(true);
		expect(browser.getStored("multi_ip_slots")).toBe(malformed);
		expect(browser.getStored("proxy_config")).toEqual(CONFIG);
		expect(error).toEqual(new Error("Failed to restore saved Firefox multi-IP proxy config"));
		expect(firefox.listeners).toHaveLength(0);
		expect(proxyManager.getState().enabled).toBe(false);
	});

	it("keeps Firefox multi-IP intent when listener installation fails and retries its slots", async () => {
		vi.resetModules();
		const browser = installChromeMock();
		const slots = [{ host: CONFIG.host, port: CONFIG.port }];
		const saved = JSON.stringify(slots);
		browser.seedStorage({ proxy_enabled: true, multi_ip_slots: saved });
		const firefox = installFirefox();
		const install = vi.spyOn(firefox.onRequest, "addListener").mockImplementation(() => {
			throw new Error("private-multi-listener-error");
		});
		const { proxyManager } = await import("../src/utils/proxy-manager");
		const error = await proxyManager.restoreState().then(() => null, (failure: unknown) => failure);
		expect(browser.getStored("proxy_enabled"), "restore failure erased saved connect intent").toBe(true);
		expect(browser.getStored("multi_ip_slots")).toBe(saved);
		expect(error).toEqual(new Error("Failed to restore saved Firefox multi-IP proxy config"));
		expect(proxyManager.isListenerActive()).toBe(false);

		install.mockRestore();
		await proxyManager.restoreState();
		expect(firefox.listeners).toHaveLength(1);
		expect(proxyManager.getMultiIpSlots()).toEqual(slots);
		expect(proxyManager.getState()).toEqual({ enabled: true, mode: "pac", config: null });
	});

	it("preserves explicit disconnect and does not restore either browser's saved configuration", async () => {
		for (const firefox of [false, true]) {
			vi.resetModules();
			const browser = installChromeMock();
			browser.seedStorage({ proxy_enabled: false, proxy_config: CONFIG });
			const listeners = firefox ? installFirefox().listeners : [];
			const { proxyManager } = await import("../src/utils/proxy-manager");
			await proxyManager.restoreState();
			expect(browser.getStored("proxy_enabled")).toBe(false);
			expect(browser.getStored("proxy_config")).toEqual(CONFIG);
			expect(browser.proxySettingsSetCalls).toHaveLength(0);
			expect(listeners).toHaveLength(0);
			expect(proxyManager.getState().enabled).toBe(false);
		}
	});

	it("does not rewrite saved intent when its required browser storage read fails", async () => {
		vi.resetModules();
		const browser = installChromeMock();
		browser.seedStorage({ proxy_enabled: true, proxy_config: CONFIG });
		const readError = new Error("browser storage is unavailable");
		vi.spyOn(chrome.storage.local, "get").mockImplementation(() => Promise.reject(readError));
		const write = vi.spyOn(chrome.storage.local, "set");
		const { proxyManager } = await import("../src/utils/proxy-manager");
		await expect(proxyManager.restoreState()).rejects.toBe(readError);
		expect(write).not.toHaveBeenCalled();
		expect(browser.getStored("proxy_enabled")).toBe(true);
		expect(browser.getStored("proxy_config")).toEqual(CONFIG);
		expect(browser.proxySettingsSetCalls).toHaveLength(0);
	});

	it("keeps an already active Chromium proxy without reapplying a different saved one", async () => {
		vi.resetModules();
		const browser = installChromeMock();
		browser.seedStorage({ proxy_enabled: true, proxy_config: CONFIG });
		const active = { ...CONFIG, host: "current-live.proxy.example.ur" };
		browser.setProxyValue({ mode: "fixed_servers", rules: { singleProxy: active } });
		const { proxyManager } = await import("../src/utils/proxy-manager");
		await proxyManager.restoreState();
		expect(proxyManager.getState()).toEqual({ enabled: true, mode: "fixed", config: active });
		expect(browser.proxySettingsSetCalls).toHaveLength(0);
		expect(browser.getStored("proxy_config")).toEqual(CONFIG);
	});
});
