// The popup's connection manager asks the background to connect, disconnect
// and log out (background/index.ts POPUP_*) and shows what comes back: the
// server's reason when a connect is refused, and the health check's reports
// while the popup is open. The background provisions the install's one client
// with the kept connect options, since no ur.io tab is attached to a popup
// connect; every later connect, and a reattach, provisions nothing. Wired here
// to the bridge's popup entry points, as background/index.ts relays them.
//
// A popup that opens (reattach) shows what the health check last reported, as
// a popup open all along does. It used to show Connected over any proxy that
// was set, so a popup opened while the kill switch held a proxy that did not
// answer said Connected until the next check (up to a minute and 8 s later),
// and one opened after the checks took the proxy off never said why.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { ConnectionManager, type ConnectionStatus } from "../src/utils/connection-manager";
import { parsePerformanceProfile, storePerformanceProfile } from "../src/utils/performance-profile";
import type { ConnectLocation } from "../src/utils/sdk-types";
import { FIXED_IP_STREAMING, wireProfile, wireWindow } from "./performance-profiles";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const LIMIT_MESSAGE =
	"Your plan's limit of 5 active proxies is reached. Remove a proxy to create another, or upgrade to UR Pro for more.";
// utils/connection-manager.ts, quoted in ur.io's browser tour
const UNREACHABLE_MESSAGE =
	"The proxy is not answering. The kill switch keeps the browser offline until it does.";
const FELL_BACK_MESSAGE =
	"The proxy stopped answering, so the browser went back to a direct connection. Connect to try again.";

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

describe("popup connection manager", () => {
	let h: BridgeHarness;

	beforeEach(async () => {
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: JWT });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
	});

	// a popup's manager, relayed to the background the way background/index.ts does
	function popupManager() {
		const statuses: ConnectionStatus[] = [];
		const errors: Array<string | null> = [];
		const sent: string[] = [];
		const manager = new ConnectionManager(
			{
				onStatusChange: (s) => statuses.push(s),
				onProxyChange: () => {},
				onError: (m) => errors.push(m),
			},
			async (message) => {
				sent.push(String(message.type));
				if (message.type === "POPUP_CONNECT") {
					const outcome = await h.bridge.connectFromPopup(
						(message.location ?? undefined) as ConnectLocation | undefined,
					);
					return outcome.ok
						? { success: true, session: outcome.session }
						: { success: false, error: outcome.error, code: outcome.code };
				}
				if (message.type === "POPUP_DISCONNECT") {
					return { success: true, session: await h.bridge.disconnectFromPopup() };
				}
				if (message.type === "POPUP_END_SESSION") {
					return { success: true, session: await h.bridge.endFromPopup() };
				}
				return undefined;
			},
		);
		return { manager, statuses, errors, sent };
	}

	const location1 = { connect_location_id: { location_id: "location-1" } } as ConnectLocation;
	const sentProfile = (call: number) =>
		h.api.authNetworkClient.mock.calls[call][0].proxy_config.initial_device_state.performance_profile;

	it("provisions the one client with the kept connect options", async () => {
		await storePerformanceProfile(parsePerformanceProfile(FIXED_IP_STREAMING));
		const popup = popupManager();

		await popup.manager.connect(location1);

		expect(popup.manager.getStatus()).toBe("connected");
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(sentProfile(0)).toEqual(wireProfile("speed", wireWindow(1, 1)));
	});

	it("provisions auto when ur.io never handed any over", async () => {
		await popupManager().manager.connect(location1);

		expect(sentProfile(0)).toBeNull();
	});

	it("connect, disconnect, connect again and a reattach provision one client", async () => {
		const first = popupManager();
		await first.manager.connect(location1);
		await first.manager.disconnect();
		expect(first.statuses).toEqual(["connecting", "connected", "idle"]);

		// the hook makes a new manager after a disconnect, and the popup reopens
		const second = popupManager();
		await second.manager.connect(location1);
		const reopened = popupManager();
		await reopened.manager.reattach(true);

		expect(second.manager.getStatus()).toBe("connected");
		expect(reopened.manager.getStatus()).toBe("connected");
		expect(reopened.sent).toEqual([]);
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
	});

	it("shows the server's reason when the connect is refused", async () => {
		h.api.authNetworkClient.mockImplementationOnce(async () => ({
			proxy_config_result: null,
			error: { message: LIMIT_MESSAGE, client_limit_exceeded: true, upgrade_required: true },
		}));
		const popup = popupManager();

		await popup.manager.connect(location1);

		expect(popup.manager.getStatus()).toBe("error");
		expect(popup.errors.at(-1)).toBe(LIMIT_MESSAGE);
	});

	it("shows why the background could not be asked", async () => {
		const errors: Array<string | null> = [];
		const manager = new ConnectionManager(
			{ onStatusChange: () => {}, onProxyChange: () => {}, onError: (m) => errors.push(m) },
			async () => {
				throw new Error("Could not establish connection. Receiving end does not exist.");
			},
		);

		await manager.connect(location1);

		expect(manager.getStatus()).toBe("error");
		expect(errors.at(-1)).toBe("Could not establish connection. Receiving end does not exist.");
	});

	it("shows the health check's reports while the popup is open", async () => {
		const popup = popupManager();
		await popup.manager.connect(location1);
		const deliver = (outcome: string) => {
			for (const listener of [...h.chrome.onMessageListeners]) {
				listener({ type: "PROXY_HEALTH", outcome });
			}
		};

		deliver("unreachable");
		expect(popup.manager.getStatus()).toBe("degraded");
		expect(popup.errors.at(-1)).toMatch(/kill switch/);
		deliver("healthy");
		expect(popup.manager.getStatus()).toBe("connected");
		expect(popup.errors.at(-1)).toBeNull();
		deliver("fell_back");
		expect(popup.manager.getStatus()).toBe("error");
		expect(popup.errors.at(-1)).toMatch(/direct connection/);
	});

	describe("a popup that opens shows what the health check last reported", () => {
		let health: typeof import("../src/utils/proxy-health");

		beforeEach(async () => {
			// the same module registry as the bridge the harness loaded
			health = await import("../src/utils/proxy-health");
		});

		// tests/setup.ts fails every fetch: the proxy does not answer
		async function failChecks(n: number) {
			for (let i = 0; i < n; i++) await health.performHealthCheck();
		}

		function deliver(outcome: string) {
			for (const listener of [...h.chrome.onMessageListeners]) {
				listener({ type: "PROXY_HEALTH", outcome });
			}
		}

		it("during an outage the kill switch holds: why, not Connected", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await popupManager().manager.connect(location1);
			await failChecks(3);
			expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });

			// the popup closes, and opens again over the proxy that is still set
			const reopened = popupManager();
			await reopened.manager.reattach(true);

			expect(reopened.manager.getStatus()).toBe("degraded");
			expect(reopened.errors.at(-1)).toBe(UNREACHABLE_MESSAGE);
			expect(reopened.sent).toEqual([]);
		});

		it("after the checks took the proxy off: why", async () => {
			await popupManager().manager.connect(location1);
			await failChecks(3);
			expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });

			const reopened = popupManager();
			await reopened.manager.reattach(false);

			expect(reopened.manager.getStatus()).toBe("error");
			expect(reopened.errors.at(-1)).toBe(FELL_BACK_MESSAGE);
		});

		it("before the third failure, as an open popup: Connected", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await popupManager().manager.connect(location1);
			await failChecks(2);

			const reopened = popupManager();
			await reopened.manager.reattach(true);

			expect(reopened.manager.getStatus()).toBe("connected");
		});

		it("a passing check, a connect or a disconnect ends the report", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			const popup = popupManager();
			await popup.manager.connect(location1);

			await failChecks(3);
			vi.stubGlobal("fetch", async () => ({ ok: true }));
			expect(await health.performHealthCheck()).toBe("healthy");
			const afterPass = popupManager();
			await afterPass.manager.reattach(true);
			expect(afterPass.manager.getStatus()).toBe("connected");

			vi.stubGlobal("fetch", async () => {
				throw new Error("unreachable");
			});
			await failChecks(3);
			// applies the saved client again, starting the count afresh
			await popup.manager.connect(location1);
			const afterConnect = popupManager();
			await afterConnect.manager.reattach(true);
			expect(afterConnect.manager.getStatus()).toBe("connected");

			await failChecks(3);
			await popup.manager.disconnect();
			const afterDisconnect = popupManager();
			await afterDisconnect.manager.reattach(false);
			expect(afterDisconnect.manager.getStatus()).toBe("idle");
			expect(afterDisconnect.errors).toEqual([]);
		});

		it("a report that arrives while the popup reads the kept one is newer, and wins", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await popupManager().manager.connect(location1);
			await failChecks(3);

			const reopened = popupManager();
			const opening = reopened.manager.reattach(true);
			// the next check passes while the kept report is still being read
			deliver("healthy");
			await opening;

			expect(reopened.manager.getStatus()).toBe("connected");
			expect(reopened.errors.at(-1)).toBeNull();
		});
	});

	it("logout ends the client, and a disconnected manager stops listening", async () => {
		const popup = popupManager();
		await popup.manager.connect(location1);
		expect(h.chrome.onMessageListeners).toHaveLength(1);

		await popup.manager.endSession();

		expect(popup.sent).toEqual(["POPUP_CONNECT", "POPUP_END_SESSION"]);
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(clientId(1), JWT);
		expect(h.chrome.onMessageListeners).toHaveLength(0);
	});
});
