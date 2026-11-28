// extension#27, owner 2026-11-28 ("hold Connecting until healthy"). The popup
// said Connected as soon as the background answered its connect, which it did
// once the proxy was set (background/index.ts POPUP_CONNECT): a new client may
// not carry traffic yet, and nothing had checked. Now the background answers
// once the first health check after the connect ends
// (utils/proxy-health.ts checkAfterConnect), and the popup shows Connecting
// until then: Connected once a probe passed; Degraded when none passed in
// connectCheckTimeoutMs (a failed run like any, so the kill switch's decision
// comes after the usual three); the out-of-data alert when the account has no
// data left. A popup that opens during the check waits for the same end.
//
// The check's clock is the test's: its waits move it, so the timeout passes
// with no real wait, and the minute schedule's checks follow on the same
// timeline (tests/health-schedule.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { minuteSchedule } from "./health-schedule";
import {
	ConnectionManager,
	type ConnectionStatus,
	type DegradedCause,
	type OutOfBalanceAlert,
} from "../src/utils/connection-manager";
import type { ConnectLocation } from "../src/utils/sdk-types";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const location1 = { connect_location_id: { location_id: "location-1" } } as ConnectLocation;

function provisioned(n: number) {
	return {
		by_client_jwt: makeJwt({ client_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}` }),
		proxy_config_result: {
			auth_token: `SIGNED${n}`,
			instance_id: `aaaaaaaa-bbbb-cccc-dddd-${n.toString(16).padStart(12, "0")}`,
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
		},
	};
}

// probes that wait until the test answers each one
type HeldProbe = { pass: () => void; fail: () => void };
function holdProbes(): HeldProbe[] {
	const held: HeldProbe[] = [];
	vi.stubGlobal(
		"fetch",
		() =>
			new Promise((resolve, reject) => {
				held.push({ pass: () => resolve({ ok: true }), fail: () => reject(new Error("no answer")) });
			}),
	);
	return held;
}

function countProbes(answer: (n: number) => boolean): { count: () => number } {
	let n = 0;
	vi.stubGlobal("fetch", async () => {
		n++;
		if (!answer(n)) throw new Error("no answer");
		return { ok: true };
	});
	return { count: () => n };
}

describe("the check after a connect", () => {
	let h: BridgeHarness;
	let health: typeof import("../src/utils/proxy-health");
	let clock: ReturnType<typeof minuteSchedule>;
	let sleeps: number[];
	const sleep = async (ms: number) => {
		sleeps.push(ms);
		clock.advance(ms);
	};
	const check = () =>
		health.checkAfterConnect(() => {}, health.defaultProxyHealthSettings(), clock.now, sleep);
	const popupMessages = () =>
		h.chrome.runtimeMessages.filter((m) => (m as { type?: string }).type === "PROXY_HEALTH");

	beforeEach(async () => {
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: JWT });
		h.api.authNetworkClient.mockImplementation(async () => provisioned(1));
		// the same module registry as the bridge the harness loaded
		health = await import("../src/utils/proxy-health");
		clock = minuteSchedule(health);
		sleeps = [];
		expect((await h.bridge.connectFromPopup(location1)).ok).toBe(true);
	});

	it("probes until one passes, and records nothing", async () => {
		const probes = countProbes((n) => n === 3);

		expect(await check()).toBe("healthy");

		expect(probes.count()).toBe(3);
		expect(sleeps).toEqual([2_000, 2_000]);
		expect(h.chrome.getStored("proxy_health_failures")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
		expect(h.chrome.getStored("proxy_connect_check")).toBeUndefined();
		expect(popupMessages()).toEqual([]);
	});

	it("no answer in time: one failure, the proxy stays set, and the report says so", async () => {
		const probes = countProbes(() => false);
		const start = clock.now();

		expect(await check()).toBe("unanswered");

		// one probe every two seconds, none started without the time to finish
		expect(probes.count()).toBe(10);
		expect(clock.now() - start).toBeLessThanOrEqual(20_000);
		expect(h.chrome.getStored("proxy_health_failures")).toBe(1);
		expect(h.chrome.getStored("proxy_health_report")).toBe("unanswered");
		expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
		expect(h.chrome.getStored("proxy_connect_check")).toBeUndefined();
		expect(popupMessages()).toEqual([{ type: "PROXY_HEALTH", outcome: "unanswered" }]);
	});

	it("then a passing check ends the report, and tells the popup", async () => {
		countProbes(() => false);
		await check();

		countProbes(() => true);
		expect(await clock.check()).toBe("healthy");

		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_failures")).toBeUndefined();
		expect(popupMessages().at(-1)).toEqual({ type: "PROXY_HEALTH", outcome: "healthy" });
	});

	it("the kill switch off: two more failed checks take the proxy off, the three of the schedule", async () => {
		countProbes(() => false);
		await check();

		expect(await clock.check()).toBe("failing");
		expect(await clock.check()).toBe("fell_back");

		expect(h.chrome.ownProxyValue()).toBeNull();
		expect(h.chrome.getStored("proxy_health_report")).toBe("fell_back");
	});

	it("the kill switch on: kept set, and at the third failure the kill switch's report", async () => {
		h.chrome.seedStorage({ kill_switch_enabled: true });
		countProbes(() => false);
		await check();

		expect(await clock.check()).toBe("failing");
		expect(await clock.check()).toBe("unreachable");

		expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
		expect(h.chrome.getStored("proxy_health_report")).toBe("unreachable");
	});

	it("out of data: the out-of-data episode, not a failure", async () => {
		countProbes(() => false);
		h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: 0, pro: false }));

		expect(await check()).toBe("out_of_balance");

		expect(h.chrome.getStored("proxy_health_report")).toBe("out_of_balance");
		expect(popupMessages()).toEqual([{ type: "PROXY_HEALTH", outcome: "out_of_balance", plan: "free" }]);
	});

	it("a disconnect during a probe: the check ends and records nothing", async () => {
		const held = holdProbes();
		const outcome = check();
		await vi.waitFor(() => expect(held).toHaveLength(1));
		expect(h.chrome.getStored("proxy_connect_check")).toBe(true);

		await h.bridge.disconnectFromPopup();
		held[0].fail();

		expect(await outcome).toBe("idle");
		expect(held).toHaveLength(1);
		expect(h.chrome.getStored("proxy_health_failures")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
		expect(h.chrome.getStored("proxy_connect_check")).toBeUndefined();
	});

	it("a connect while it reads the balance: it counts no failure against the new proxy", async () => {
		countProbes(() => false);
		let answerBalance: (reading: null) => void = () => {};
		h.api.subscriptionBalance.mockImplementation(
			() =>
				new Promise((resolve) => {
					answerBalance = resolve;
				}),
		);
		const outcome = check();
		await vi.waitFor(() => expect(h.api.subscriptionBalance).toHaveBeenCalled());

		expect((await h.bridge.connectFromPopup(location1)).ok).toBe(true);
		answerBalance(null);

		expect(await outcome).toBe("idle");
		expect(h.chrome.getStored("proxy_health_failures")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
	});

	it("a scheduled run that spans a connect counts nothing against the new proxy", async () => {
		// two failures in, so a third would take the proxy off
		countProbes(() => false);
		expect(await clock.check()).toBe("failing");
		expect(await clock.check()).toBe("failing");
		let answerBalance: (reading: null) => void = () => {};
		h.api.subscriptionBalance.mockImplementation(
			() =>
				new Promise((resolve) => {
					answerBalance = resolve;
				}),
		);
		const third = clock.check();
		await vi.waitFor(() => expect(h.api.subscriptionBalance).toHaveBeenCalledTimes(3));

		// a connect while the third run reads the balance: its failure was the old proxy's
		expect((await h.bridge.connectFromPopup(location1)).ok).toBe(true);
		answerBalance(null);

		expect(await third).toBe("idle");
		expect(h.chrome.ownProxyValue()).not.toBeNull();
		expect(h.chrome.getStored("proxy_health_failures")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
	});

	it("is the one check at a time: a scheduled one shares it", async () => {
		const held = holdProbes();
		const outcome = check();
		await vi.waitFor(() => expect(held).toHaveLength(1));

		expect(health.requestHealthCheck("scheduled")).toBe(outcome);
		expect(health.requestHealthCheck("proxy_error")).toBe(outcome);
		held[0].pass();

		expect(await outcome).toBe("healthy");
		expect(held).toHaveLength(1);
	});

	it("waits for a check that began before it", async () => {
		const held = holdProbes();
		const scheduled = health.requestHealthCheck("scheduled", () => {}, health.defaultProxyHealthSettings(), clock.now);
		await vi.waitFor(() => expect(held).toHaveLength(1));

		const outcome = check();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(held).toHaveLength(1);

		held[0].pass();
		expect(await scheduled).toBe("healthy");
		await vi.waitFor(() => expect(held).toHaveLength(2));
		held[1].pass();
		expect(await outcome).toBe("healthy");
	});

	it("a popup that opens during it gets its outcome; none runs after", async () => {
		const held = holdProbes();
		const outcome = check();
		await vi.waitFor(() => expect(held).toHaveLength(1));

		const waiting = health.connectCheckOutcome();
		held[0].pass();

		expect(await waiting).toBe("healthy");
		await outcome;
		expect(await health.connectCheckOutcome()).toBeNull();
	});

	it("turned off: no check", async () => {
		const probes = countProbes(() => true);
		const settings = { ...health.defaultProxyHealthSettings(), connectCheckTimeoutMs: 0 };

		expect(await health.checkAfterConnect(() => {}, settings, clock.now, sleep)).toBe("skipped");
		expect(probes.count()).toBe(0);
	});
});

describe("the popup holds Connecting until the first check after a connect ends", () => {
	let h: BridgeHarness;
	let health: typeof import("../src/utils/proxy-health");
	let clock: ReturnType<typeof minuteSchedule>;
	let forwarded = 0;

	beforeEach(async () => {
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: JWT });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
		health = await import("../src/utils/proxy-health");
		clock = minuteSchedule(health);
		forwarded = 0;
	});

	// a popup's manager, relayed to the background the way background/index.ts
	// does: a connect answers once the check after it ends
	function popupManager() {
		const statuses: ConnectionStatus[] = [];
		const errors: Array<string | null> = [];
		const alerts: Array<OutOfBalanceAlert | null> = [];
		const causes: Array<DegradedCause | null> = [];
		const sent: string[] = [];
		const sleep = async (ms: number) => clock.advance(ms);
		const checkEnd = async (outcome: Promise<unknown>) => ({
			health: await outcome.catch(() => null),
			view: await h.bridge.proxyViewForPopup(),
		});
		const manager = new ConnectionManager(
			{
				onStatusChange: (s) => statuses.push(s),
				onProxyChange: () => {},
				onError: (m) => errors.push(m),
				onOutOfBalance: (a) => alerts.push(a),
				onDegraded: (c) => causes.push(c),
			},
			async (msg) => {
				sent.push(String(msg.type));
				if (msg.type === "POPUP_CONNECT") {
					const outcome = await h.bridge.connectFromPopup(
						(msg.location ?? undefined) as ConnectLocation | undefined,
					);
					if (!outcome.ok) return { success: false, error: outcome.error, code: outcome.code };
					const check = health.checkAfterConnect(() => {}, health.defaultProxyHealthSettings(), clock.now, sleep);
					return { success: true, session: outcome.session, ...(await checkEnd(check)) };
				}
				if (msg.type === "POPUP_CONNECT_CHECK") {
					return { success: true, ...(await checkEnd(health.connectCheckOutcome())) };
				}
				if (msg.type === "POPUP_DISCONNECT") {
					const session = await h.bridge.disconnectFromPopup();
					return { success: true, session, view: await h.bridge.proxyViewForPopup() };
				}
				return undefined;
			},
		);
		return { manager, statuses, errors, alerts, causes, sent };
	}

	const reopen = async () => {
		const popup = popupManager();
		await popup.manager.reattach(await h.bridge.proxyViewForPopup());
		return popup;
	};

	// what the background sent since the last call reaches the open popups
	function forwardSent() {
		const sent = h.chrome.runtimeMessages.slice(forwarded);
		forwarded = h.chrome.runtimeMessages.length;
		for (const msg of sent) {
			for (const listener of [...h.chrome.onMessageListeners]) listener(msg);
		}
	}

	it("Connecting while the first probe is out, Connected once it passes", async () => {
		const held = holdProbes();
		const popup = popupManager();

		const connecting = popup.manager.connect(location1);
		await vi.waitFor(() => expect(held).toHaveLength(1));
		// the proxy is set, and not Connected yet
		expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
		expect(popup.manager.getStatus()).toBe("connecting");

		held[0].pass();

		expect(await connecting).toBe("connected");
		expect(popup.statuses).toEqual(["connecting", "connected"]);
	});

	it("no answer in time: Degraded, unanswered, with the proxy set and no error", async () => {
		countProbes(() => false);
		const popup = popupManager();

		expect(await popup.manager.connect(location1)).toBe("connected");

		expect(popup.statuses).toEqual(["connecting", "degraded"]);
		expect(popup.causes).toEqual(["unanswered"]);
		expect(popup.errors.at(-1)).toBeNull();
		expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
	});

	it("a popup that opens after it: Degraded; the next passing check: Connected", async () => {
		countProbes(() => false);
		await popupManager().manager.connect(location1);

		const reopened = await reopen();
		expect(reopened.manager.getStatus()).toBe("degraded");
		expect(reopened.causes).toEqual(["unanswered"]);
		expect(reopened.sent).toEqual([]);

		countProbes(() => true);
		forwardSent();
		expect(await clock.check()).toBe("healthy");
		forwardSent();

		expect(reopened.manager.getStatus()).toBe("connected");
		expect(reopened.causes.at(-1)).toBeNull();
	});

	it("a popup that opens while the check runs shows Connecting, then how it ended", async () => {
		const held = holdProbes();
		const first = popupManager();
		const connecting = first.manager.connect(location1);
		await vi.waitFor(() => expect(held).toHaveLength(1));

		// the popup closed with the check out, and opens again
		first.manager.destroy();
		const reopened = popupManager();
		const opening = reopened.manager.reattach(await h.bridge.proxyViewForPopup());
		await vi.waitFor(() => expect(reopened.manager.getStatus()).toBe("connecting"));

		held[0].pass();
		await opening;
		await connecting;

		expect(reopened.statuses).toEqual(["connecting", "connected"]);
		expect(reopened.sent).toEqual(["POPUP_CONNECT_CHECK"]);
	});

	it("a check a stopped background left behind: the reopened popup is answered at once", async () => {
		countProbes(() => true);
		await popupManager().manager.connect(location1);
		// the service worker stopped mid-check, which leaves the flag
		h.chrome.seedStorage({ proxy_connect_check: true });

		const reopened = await reopen();

		expect(reopened.statuses).toEqual(["connecting", "connected"]);
		expect(reopened.sent).toEqual(["POPUP_CONNECT_CHECK"]);
	});

	it("out of data at the connect: the alert", async () => {
		countProbes(() => false);
		h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: 0, pro: false }));
		const popup = popupManager();

		await popup.manager.connect(location1);

		expect(popup.manager.getStatus()).toBe("out_of_balance");
		expect(popup.alerts.at(-1)).toEqual({ plan: "free", held: true });
	});

	it("a Disconnect while Connecting: Disconnected, and the check records nothing", async () => {
		const held = holdProbes();
		const popup = popupManager();
		const connecting = popup.manager.connect(location1);
		await vi.waitFor(() => expect(held).toHaveLength(1));

		await popup.manager.disconnect();
		held[0].fail();

		expect(await connecting).toBe("skipped");
		expect(popup.manager.getStatus()).toBe("idle");
		expect(h.chrome.ownProxyValue()).toBeNull();
		expect(h.chrome.getStored("proxy_health_failures")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
	});
});

describe("the background answers a popup's connect once its first check ends", () => {
	const OUR_PROXY = {
		mode: "fixed_servers",
		rules: { singleProxy: { scheme: "https", host: "SIGNED1.proxy.example.ur", port: 8443 } },
	};
	let mock: ChromeMock;

	// lets every pending storage read and probe settle
	const settle = async () => {
		for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
	};

	beforeEach(async () => {
		vi.resetModules();
		mock = installChromeMock();
		mock.seedStorage({ by_jwt: JWT });
		vi.doMock("../src/bridge/api", () => ({
			authNetworkClient: vi.fn(),
			removeNetworkClient: vi.fn(async () => true),
			activeProxyClientIds: vi.fn(async () => null),
			subscriptionBalance: vi.fn(async () => null),
		}));
		// the connect itself: the proxy is set, as connectInternal leaves it
		vi.doMock("../src/bridge/background", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/bridge/background")>()),
			connectFromPopup: vi.fn(async () => {
				mock.setProxyValue(OUR_PROXY);
				return { ok: true, session: { connected: true } };
			}),
		}));
		// the background's start (restore after 2 s) never runs here
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		await import("../src/background/index");
		await settle();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("../src/bridge/api");
		vi.doUnmock("../src/bridge/background");
	});

	// a popup's message to the background; answered: whether it answered yet
	function ask(message: Record<string, unknown>) {
		let answered = false;
		const answer = new Promise<unknown>((resolve) => {
			for (const responder of mock.onMessageResponders) {
				responder(message, {}, (response) => {
					answered = true;
					resolve(response);
				});
			}
		});
		return { answer, answered: () => answered };
	}

	it("POPUP_CONNECT is answered only after the first probe passes", async () => {
		const held = holdProbes();

		const connect = ask({ type: "POPUP_CONNECT", location: null });
		await settle();
		expect(held).toHaveLength(1);
		expect(connect.answered()).toBe(false);

		held[0].pass();

		expect(await connect.answer).toMatchObject({
			success: true,
			health: "healthy",
			view: { enabled: true, control: "ours" },
		});
	});

	it("POPUP_CONNECT_CHECK with no check running is answered at once", async () => {
		mock.setProxyValue(OUR_PROXY);

		const waiting = ask({ type: "POPUP_CONNECT_CHECK" });

		expect(await waiting.answer).toMatchObject({ success: true, health: null, view: { enabled: true } });
	});
});
