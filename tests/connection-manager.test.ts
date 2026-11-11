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
//
// Owner approval 2026-11-11:
// - a popup that opens shows nothing until the background answers (B5): the
//   manager starts loading, not Disconnected;
// - a location change that fails, not at a plan limit, leaves the install's
//   previous proxy set (B3): the popup said Disconnected and offered Connect,
//   and now shows the proxy that is still set, with the reason;
// - another extension or policy holding the proxy setting shows as such (B2);
// - out of data shows the out-of-data alert, kept after a Disconnect (A);
// - its messages come from the extension's locale catalogs (B6).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { message } from "./chrome-mock";
import { minuteSchedule } from "./health-schedule";
import {
	ConnectionManager,
	type BlockedProxy,
	type ConnectionStatus,
	type OutOfBalanceAlert,
} from "../src/utils/connection-manager";
import { parsePerformanceProfile, storePerformanceProfile } from "../src/utils/performance-profile";
import type { ConnectLocation } from "../src/utils/sdk-types";
import { FIXED_IP_STREAMING, wireProfile, wireWindow } from "./performance-profiles";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const LIMIT_MESSAGE =
	"Your plan's limit of 5 active proxies is reached. Remove a proxy to create another, or upgrade to UR Pro for more.";
// the English the popup shows, quoted in ur.io's browser tour
const CONNECT_FAILED = "Failed to connect. Check your account.";
const FELL_BACK =
	"The proxy stopped answering, so the extension turned it off. This browser connects without URnetwork until you connect again.";

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
	// how many of the background's messages forwardSent has delivered
	let forwarded = 0;

	beforeEach(async () => {
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: JWT });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
		forwarded = 0;
	});

	// a popup's manager, relayed to the background the way background/index.ts
	// does: a failure answers with the proxy as it stands
	function popupManager() {
		const statuses: ConnectionStatus[] = [];
		const errors: Array<string | null> = [];
		const alerts: Array<OutOfBalanceAlert | null> = [];
		const blocks: Array<BlockedProxy | null> = [];
		const sent: string[] = [];
		const failure = async (error: unknown, code: unknown) => ({
			success: false,
			error,
			code,
			view: await h.bridge.proxyViewForPopup(),
		});
		const manager = new ConnectionManager(
			{
				onStatusChange: (s) => statuses.push(s),
				onProxyChange: () => {},
				onError: (m) => errors.push(m),
				onOutOfBalance: (a) => alerts.push(a),
				onBlocked: (b) => blocks.push(b),
			},
			async (msg) => {
				sent.push(String(msg.type));
				if (msg.type === "POPUP_CONNECT") {
					try {
						const outcome = await h.bridge.connectFromPopup(
							(msg.location ?? undefined) as ConnectLocation | undefined,
						);
						return outcome.ok
							? { success: true, session: outcome.session }
							: failure(outcome.error, outcome.code);
					} catch (err) {
						return failure((err as Error).message, (err as { code?: string }).code);
					}
				}
				if (msg.type === "POPUP_DISCONNECT") {
					const session = await h.bridge.disconnectFromPopup();
					return { success: true, session, view: await h.bridge.proxyViewForPopup() };
				}
				if (msg.type === "POPUP_END_SESSION") {
					const session = await h.bridge.endFromPopup();
					return { success: true, session, view: await h.bridge.proxyViewForPopup() };
				}
				return undefined;
			},
		);
		return { manager, statuses, errors, alerts, blocks, sent };
	}

	// what the popup opens with (background/index.ts GET_VPN_STATE)
	const reopen = async () => {
		const popup = popupManager();
		await popup.manager.reattach(await h.bridge.proxyViewForPopup());
		return popup;
	};

	function deliver(msg: Record<string, unknown>) {
		for (const listener of [...h.chrome.onMessageListeners]) listener(msg);
	}

	// what the background sent since the last call reaches an open popup, as
	// chrome.runtime.sendMessage does (the mock only records it)
	function forwardSent() {
		const sent = h.chrome.runtimeMessages.slice(forwarded);
		forwarded = h.chrome.runtimeMessages.length;
		for (const msg of sent) deliver(msg as Record<string, unknown>);
	}

	const location1 = { connect_location_id: { location_id: "location-1" } } as ConnectLocation;
	const location2 = { connect_location_id: { location_id: "location-2" } } as ConnectLocation;
	const sentProfile = (call: number) =>
		h.api.authNetworkClient.mock.calls[call][0].proxy_config.initial_device_state.performance_profile;

	it("starts loading: no state until the background answers", () => {
		const popup = popupManager();

		expect(popup.manager.getStatus()).toBe("loading");
		expect(popup.statuses).toEqual([]);
	});

	it("provisions the one client with the kept connect options", async () => {
		await storePerformanceProfile(parsePerformanceProfile(FIXED_IP_STREAMING));
		const popup = popupManager();

		const result = await popup.manager.connect(location1);

		expect(popup.manager.getStatus()).toBe("connected");
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(sentProfile(0)).toEqual(wireProfile("speed", wireWindow(1, 1)));
		expect(result).toBe("connected");
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
		const reopened = await reopen();

		expect(second.manager.getStatus()).toBe("connected");
		expect(reopened.manager.getStatus()).toBe("connected");
		expect(reopened.sent).toEqual([]);
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
	});

	it("a popup opened over no proxy is Disconnected", async () => {
		const reopened = await reopen();

		expect(reopened.statuses).toEqual(["idle"]);
	});

	it("shows the server's reason when the connect is refused", async () => {
		h.api.authNetworkClient.mockImplementationOnce(async () => ({
			proxy_config_result: null,
			error: { message: LIMIT_MESSAGE, client_limit_exceeded: true, upgrade_required: true },
		}));
		const popup = popupManager();

		const result = await popup.manager.connect(location1);

		expect(popup.manager.getStatus()).toBe("error");
		expect(popup.errors.at(-1)).toBe(LIMIT_MESSAGE);
		expect(result).toBe("failed");
	});

	it("says the connect failed when no reason came back", async () => {
		h.api.authNetworkClient.mockImplementationOnce(async () => ({
			proxy_config_result: null,
			error: { message: "" },
		}));
		const popup = popupManager();

		await popup.manager.connect(location1);

		expect(popup.manager.getStatus()).toBe("error");
		expect(popup.errors.at(-1)).toBe(CONNECT_FAILED);
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

	describe("a location change that fails with the previous proxy still set", () => {
		it("is still connected, with the reason and a working Disconnect", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);
			// not a plan limit: the server answers no proxy for the new location
			h.api.authNetworkClient.mockImplementationOnce(async () => ({
				proxy_config_result: null,
				error: { message: "No providers are available at that location." },
			}));

			const result = await popup.manager.connect(location2);

			expect(popup.manager.getStatus()).toBe("connected");
			expect(popup.errors.at(-1)).toBe("No providers are available at that location.");
			// the browser still goes through the install's first client
			expect(h.chrome.proxyValue()).toMatchObject({
				mode: "fixed_servers",
				rules: { singleProxy: { host: "SIGNED1.proxy.example.ur" } },
			});
			expect(result).toBe("kept");

			await popup.manager.disconnect();
			expect(popup.manager.getStatus()).toBe("idle");
			expect(h.chrome.levelOfControl()).toBe("controllable_by_this_extension");
		});

		it("a configuration that does not come back whole", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);
			h.api.authNetworkClient.mockImplementationOnce(async () => ({
				by_client_jwt: makeJwt({ client_id: clientId(9) }),
				proxy_config_result: { auth_token: "SIGNED9" },
			}));

			const result = await popup.manager.connect(location2);

			expect(popup.manager.getStatus()).toBe("connected");
			// the background's own failure, in the popup's words
			expect(popup.errors.at(-1)).toBe(CONNECT_FAILED);
			expect(result).toBe("kept");
		});

		it("during an outage the kill switch holds: still degraded", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			const popup = popupManager();
			await popup.manager.connect(location1);
			const health = await import("../src/utils/proxy-health");
			const schedule = minuteSchedule(health);
			for (let i = 0; i < 3; i++) await schedule.check();
			h.api.authNetworkClient.mockImplementationOnce(async () => ({
				proxy_config_result: null,
				error: { message: "No providers are available at that location." },
			}));

			const result = await popup.manager.connect(location2);

			expect(popup.manager.getStatus()).toBe("degraded");
			expect(popup.errors.at(-1)).toBe("No providers are available at that location.");
			expect(result).toBe("kept");
		});

		it("at the plan's limit the proxy came off: Disconnected with the reason, as before", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);
			h.api.authNetworkClient.mockImplementation(async () => ({
				proxy_config_result: null,
				error: { message: LIMIT_MESSAGE, client_limit_exceeded: true, upgrade_required: true },
			}));

			const result = await popup.manager.connect(location2);

			expect(popup.manager.getStatus()).toBe("error");
			expect(popup.errors.at(-1)).toBe(LIMIT_MESSAGE);
			expect(result).toBe("failed");
		});
	});

	it("shows the health check's reports while the popup is open", async () => {
		const popup = popupManager();
		await popup.manager.connect(location1);

		deliver({ type: "PROXY_HEALTH", outcome: "unreachable" });
		expect(popup.manager.getStatus()).toBe("degraded");
		deliver({ type: "PROXY_HEALTH", outcome: "healthy" });
		expect(popup.manager.getStatus()).toBe("connected");
		expect(popup.errors.at(-1)).toBeNull();
		deliver({ type: "PROXY_HEALTH", outcome: "fell_back" });
		expect(popup.manager.getStatus()).toBe("error");
		expect(popup.errors.at(-1)).toBe(FELL_BACK);
	});

	describe("a popup that opens shows what the health check last reported", () => {
		let health: typeof import("../src/utils/proxy-health");

		beforeEach(async () => {
			// the same module registry as the bridge the harness loaded
			health = await import("../src/utils/proxy-health");
		});

		// tests/setup.ts fails every fetch: the proxy does not answer
		async function failChecks(n: number, schedule = minuteSchedule(health)) {
			for (let i = 0; i < n; i++) await schedule.check();
		}

		it("during an outage the kill switch holds: why, not Connected", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await popupManager().manager.connect(location1);
			await failChecks(3);
			expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });

			// the popup closes, and opens again over the proxy that is still set
			const reopened = await reopen();

			expect(reopened.manager.getStatus()).toBe("degraded");
			expect(reopened.sent).toEqual([]);
		});

		it("after the checks took the proxy off: why", async () => {
			await popupManager().manager.connect(location1);
			await failChecks(3);
			expect(h.chrome.ownProxyValue()).toBeNull();

			const reopened = await reopen();

			expect(reopened.manager.getStatus()).toBe("error");
			expect(reopened.errors.at(-1)).toBe(FELL_BACK);
		});

		it("before the third failure, as an open popup: Connected", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await popupManager().manager.connect(location1);
			await failChecks(2);

			const reopened = await reopen();

			expect(reopened.manager.getStatus()).toBe("connected");
		});

		it("a passing check, a connect or a disconnect ends the report", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			const popup = popupManager();
			await popup.manager.connect(location1);
			const schedule = minuteSchedule(health);

			await failChecks(3, schedule);
			vi.stubGlobal("fetch", async () => ({ ok: true }));
			expect(await schedule.check()).toBe("healthy");
			const afterPass = await reopen();
			expect(afterPass.manager.getStatus()).toBe("connected");

			vi.stubGlobal("fetch", async () => {
				throw new Error("unreachable");
			});
			await failChecks(3, schedule);
			// applies the saved client again, starting the count afresh
			await popup.manager.connect(location1);
			const afterConnect = await reopen();
			expect(afterConnect.manager.getStatus()).toBe("connected");

			await failChecks(3, schedule);
			await popup.manager.disconnect();
			const afterDisconnect = await reopen();
			expect(afterDisconnect.manager.getStatus()).toBe("idle");
			expect(afterDisconnect.errors).toEqual([]);
		});

		it("a report that arrives while the popup reads the kept one is newer, and wins", async () => {
			h.chrome.seedStorage({ kill_switch_enabled: true });
			await popupManager().manager.connect(location1);
			await failChecks(3);

			const reopened = popupManager();
			const opening = reopened.manager.reattach(await h.bridge.proxyViewForPopup());
			// the next check passes while the kept report is still being read
			deliver({ type: "PROXY_HEALTH", outcome: "healthy" });
			await opening;

			expect(reopened.manager.getStatus()).toBe("connected");
			expect(reopened.errors.at(-1) ?? null).toBeNull();
		});
	});

	describe("out of data", () => {
		let health: typeof import("../src/utils/proxy-health");

		beforeEach(async () => {
			health = await import("../src/utils/proxy-health");
			h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: 0, pro: false }));
		});

		it("an open popup shows the alert, and the proxy holds", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);

			await minuteSchedule(health).check();
			forwardSent();

			expect(popup.manager.getStatus()).toBe("out_of_balance");
			expect(popup.alerts.at(-1)).toEqual({ plan: "free", held: true });
			expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
		});

		it("a popup that opens during it shows it at once", async () => {
			h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: 0, pro: true }));
			await popupManager().manager.connect(location1);
			await minuteSchedule(health).check();

			const reopened = await reopen();

			expect(reopened.manager.getStatus()).toBe("out_of_balance");
			expect(reopened.alerts.at(-1)).toEqual({ plan: "pro", held: true });
		});

		it("a Disconnect is the user's, and keeps the alert's links", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);
			await minuteSchedule(health).check();
			forwardSent();

			await popup.manager.disconnect();

			expect(popup.manager.getStatus()).toBe("idle");
			expect(popup.alerts.at(-1)).toEqual({ plan: "free", held: false });
			expect(h.chrome.levelOfControl()).toBe("controllable_by_this_extension");
		});

		it("data back while the proxy still fails: the alert goes, as for any failure not yet given up on", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);
			const schedule = minuteSchedule(health);
			await schedule.check();
			forwardSent();
			expect(popup.manager.getStatus()).toBe("out_of_balance");

			h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: 2 ** 30, pro: false }));
			await schedule.check();
			forwardSent();

			expect(popup.manager.getStatus()).toBe("connected");
			expect(popup.alerts.at(-1)).toBeNull();
		});

		it("data back: Connected, and the alert goes", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);
			const schedule = minuteSchedule(health);
			await schedule.check();
			forwardSent();
			expect(popup.manager.getStatus()).toBe("out_of_balance");

			vi.stubGlobal("fetch", async () => ({ ok: true }));
			await schedule.check();
			forwardSent();

			expect(popup.manager.getStatus()).toBe("connected");
			expect(popup.alerts.at(-1)).toBeNull();
		});
	});

	describe("another extension holds the proxy setting", () => {
		const OTHER = { mode: "fixed_servers", rules: { singleProxy: { host: "other-vpn.example", port: 443 } } };

		it("a popup that opens says so, not Connected, with Disconnect for the extension's own", async () => {
			await popupManager().manager.connect(location1);
			h.chrome.setPriorityExtensionProxy(OTHER);

			const reopened = await reopen();

			expect(reopened.manager.getStatus()).toBe("blocked");
			expect(reopened.blocks.at(-1)).toEqual({ control: "other_extension", intent: true });
		});

		it("a connect is refused and says so", async () => {
			h.chrome.setPriorityExtensionProxy(OTHER);
			const popup = popupManager();

			const result = await popup.manager.connect(location1);

			expect(popup.manager.getStatus()).toBe("blocked");
			expect(popup.blocks.at(-1)).toEqual({ control: "other_extension", intent: false });
			expect(h.api.authNetworkClient).not.toHaveBeenCalled();
			expect(result).toBe("blocked");
		});

		it("policy", async () => {
			h.chrome.setPolicyProxy({ mode: "direct" });

			const reopened = await reopen();

			expect(reopened.blocks.at(-1)).toEqual({ control: "policy", intent: false });
		});

		it("an open popup follows when another extension takes the setting and gives it back", async () => {
			const popup = popupManager();
			await popup.manager.connect(location1);

			h.chrome.setPriorityExtensionProxy(OTHER);
			deliver({ type: "PROXY_CONTROL", view: await h.bridge.proxyViewForPopup() });
			expect(popup.manager.getStatus()).toBe("blocked");

			h.chrome.setPriorityExtensionProxy(null);
			deliver({ type: "PROXY_CONTROL", view: await h.bridge.proxyViewForPopup() });
			await vi.waitFor(() => expect(popup.manager.getStatus()).toBe("connected"));
		});

		it("a Disconnect ends the extension's own value under it", async () => {
			await popupManager().manager.connect(location1);
			h.chrome.setPriorityExtensionProxy(OTHER);
			const reopened = await reopen();

			await reopened.manager.disconnect();

			expect(h.chrome.ownProxyValue()).toBeNull();
			expect(reopened.manager.getStatus()).toBe("blocked");
			expect(reopened.blocks.at(-1)).toEqual({ control: "other_extension", intent: false });
		});
	});

	it("its messages are in the browser's language", async () => {
		h.chrome.setLocale("de");
		await popupManager().manager.connect(location1);
		const health = await import("../src/utils/proxy-health");
		const schedule = minuteSchedule(health);
		for (let i = 0; i < 3; i++) await schedule.check();

		const reopened = await reopen();
		expect(reopened.errors.at(-1)).toBe(message("extension_proxy_fell_back", "de"));
		expect(reopened.errors.at(-1)).not.toBe(FELL_BACK);

		// a connect elsewhere that the server refuses with no reason
		h.api.authNetworkClient.mockImplementationOnce(async () => ({
			proxy_config_result: null,
			error: { message: "" },
		}));
		const popup = popupManager();
		await popup.manager.connect(location2);
		expect(popup.errors.at(-1)).toBe(message("extension_connect_failed", "de"));
		expect(popup.errors.at(-1)).not.toBe(CONNECT_FAILED);
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
