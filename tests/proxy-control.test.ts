// Who holds the proxy setting (B2, owner approval 2026-11-11). The extension
// never read Chromium's levelOfControl. With another proxy extension holding
// the setting with priority, the extension's set changed nothing, yet it
// reported itself connected, the popup said Connected, and the health check
// probed through the other extension's proxy; at a start, another extension's
// PAC script read as an older version's multi-IP pool, so the extension
// connected by itself. Now a value the extension does not hold is not its
// connection, a connect is refused before anything is provisioned while
// another extension or policy holds the setting, and nothing at a start is
// applied over another extension's proxy.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { SYSTEM_PROXY } from "./chrome-mock";
import { minuteSchedule } from "./health-schedule";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });

const OTHER_FIXED = {
	mode: "fixed_servers",
	rules: { singleProxy: { scheme: "https", host: "other-vpn.example", port: 443 } },
};
const OTHER_PAC = { mode: "pac_script", pacScript: { data: "function FindProxyForURL(){return 'PROXY other:1';}" } };
const OUR_CONFIG = { host: "SIGNED1.proxy.example.ur", port: 8443, scheme: "https" as const };

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

describe("another extension or policy holds the proxy setting", () => {
	let h: BridgeHarness;
	let probes: number;

	beforeEach(async () => {
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: JWT, network_name: "testnet" });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
		probes = 0;
		vi.stubGlobal("fetch", async () => {
			probes++;
			return { ok: true };
		});
	});

	it("a connected install that another extension overrides is not connected, and its proxy is not checked", async () => {
		await h.bridge.connectFromPopup(undefined);
		// another proxy extension is installed later: it wins
		h.chrome.setPriorityExtensionProxy(OTHER_FIXED);

		const session = await h.bridge.sessionForPopup();
		const health = await import("../src/utils/proxy-health");
		const outcome = await minuteSchedule(health).check();

		expect(session.connected).toBe(false);
		expect(outcome).toBe("idle");
		expect(probes).toBe(0);
	});

	it("a connect is refused before anything is provisioned", async () => {
		h.chrome.setPriorityExtensionProxy(OTHER_FIXED);

		const outcome = await h.bridge.connectFromPopup(undefined);

		expect(outcome).toMatchObject({ ok: false, code: "proxy_other_extension" });
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
		expect(h.chrome.proxyValue()).toEqual(OTHER_FIXED);
	});

	it("policy: a connect is refused", async () => {
		h.chrome.setPolicyProxy({ mode: "pac_script", pacScript: { url: "https://corp.example/proxy.pac" } });

		const outcome = await h.bridge.connectFromPopup(undefined);

		expect(outcome).toMatchObject({ ok: false, code: "proxy_policy" });
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
	});

	it("the ur.io page's CONNECT gets the refusal's code too", async () => {
		h.chrome.setPriorityExtensionProxy(OTHER_FIXED);
		const app = h.connect();

		const res = await app.request("CONNECT", { locationId: null });

		expect(res).toMatchObject({ ok: false, code: "proxy_other_extension" });
		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
	});

	it("an extension that yields to this one does not block a connect the user makes", async () => {
		h.chrome.setYieldingExtensionProxy(OTHER_FIXED);

		const outcome = await h.bridge.connectFromPopup(undefined);

		expect(outcome.ok).toBe(true);
		expect(h.chrome.levelOfControl()).toBe("controlled_by_this_extension");
	});

	it("a disconnect under another extension ends the extension's own value, and leaves the other's", async () => {
		await h.bridge.connectFromPopup(undefined);
		h.chrome.setPriorityExtensionProxy(OTHER_FIXED);

		await h.bridge.disconnectFromPopup();

		expect(h.chrome.ownProxyValue()).toBeNull();
		expect(h.chrome.proxyValue()).toEqual(OTHER_FIXED);
		expect(h.chrome.getStored("proxy_enabled")).toBe(false);
	});

	describe("at a start", () => {
		async function start() {
			const { proxyManager } = await import("../src/utils/proxy-manager");
			// background/index.ts restoreThenMigrate
			await proxyManager.restoreState().catch(() => {});
			await h.bridge.migrateLegacyMultiIp();
		}

		it("another extension's PAC script is not an older version's pool: nothing connects", async () => {
			h.chrome.setPriorityExtensionProxy(OTHER_PAC);

			await start();

			expect(h.api.authNetworkClient).not.toHaveBeenCalled();
			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
			expect(h.chrome.proxyValue()).toEqual(OTHER_PAC);
		});

		it("nor one of an extension that yields to this one", async () => {
			h.chrome.setYieldingExtensionProxy(OTHER_PAC);

			await start();

			expect(h.api.authNetworkClient).not.toHaveBeenCalled();
			expect(h.chrome.proxyValue()).toEqual(OTHER_PAC);
		});

		it("a saved connect is not applied over another extension's proxy, and stays saved", async () => {
			h.chrome.seedStorage({ proxy_enabled: true, proxy_config: OUR_CONFIG });
			h.chrome.setYieldingExtensionProxy(OTHER_FIXED);

			await start();

			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
			expect(h.chrome.proxyValue()).toEqual(OTHER_FIXED);
			expect(h.chrome.getStored("proxy_enabled")).toBe(true);
		});

		it("a saved connect is applied over the browser's own setting", async () => {
			h.chrome.seedStorage({ proxy_enabled: true, proxy_config: OUR_CONFIG });
			expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);

			await start();

			expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers", rules: { singleProxy: OUR_CONFIG } });
		});

		it("this extension's own PAC pool is still replaced by one client", async () => {
			h.chrome.seedStorage({
				multi_ip_client_ids: JSON.stringify(["pool-client-1"]),
				proxy_enabled: true,
			});
			h.chrome.setProxyValue({ mode: "pac_script", pacScript: { data: "pool" } });

			await start();

			expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
			expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
		});
	});
});
