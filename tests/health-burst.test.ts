// Bursts of proxy errors (B4, owner approval 2026-11-11). Every proxy error the
// browser reported started its own health check (background/index.ts
// onProxyError → performHealthCheck), with nothing to merge them: an outage
// fails every page's requests, and each check's own probe through the same
// proxy fails too, so checks piled up and three failures arrived within
// seconds, far sooner than the documented three checks of the one-minute
// schedule, and with the kill switch off the browser left the proxy almost at
// once. Now one check runs at a time (requestHealthCheck), a failure counts
// at most once every failureSpacingMs, and a proxy error right after a counted
// failure starts no check.
//
// The real background entry point is loaded on the chrome mock, so the proxy
// errors arrive the way the browser delivers them (chrome.proxy.onProxyError).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { makeJwt, NETWORK_ID } from "./bridge/harness";
import { minuteSchedule } from "./health-schedule";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const OUR_PROXY = {
	mode: "fixed_servers",
	rules: { singleProxy: { scheme: "https", host: "SIGNED1.proxy.example.ur", port: 8443 } },
};

// lets every pending storage read and probe settle
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function connected(mock: ChromeMock) {
	mock.setProxyValue(OUR_PROXY);
	mock.seedStorage({
		by_jwt: JWT,
		proxy_enabled: true,
		proxy_config: { host: "SIGNED1.proxy.example.ur", port: 8443, scheme: "https" },
		proxy_client_id: "client-1",
	});
}

describe("a burst of proxy errors", () => {
	let mock: ChromeMock;
	let probes: number;

	beforeEach(() => {
		vi.resetModules();
		mock = installChromeMock();
		probes = 0;
		// the background's api calls stay offline; the balance never comes back
		vi.doMock("../src/bridge/api", () => ({
			authNetworkClient: vi.fn(),
			removeNetworkClient: vi.fn(async () => true),
			activeProxyClientIds: vi.fn(async () => null),
			subscriptionBalance: vi.fn(async () => null),
		}));
		// the build's version constant (vite.config.ts define), which the
		// background's sign-in module reads at load
		vi.stubGlobal("__EXTENSION_VERSION__", "0.0.0-test");
		// the background's start (restore after 2 s) never runs here
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("../src/bridge/api");
	});

	async function loadBackground() {
		await import("../src/background/index");
		expect(mock.onProxyErrorListeners).toHaveLength(1);
	}

	function proxyError() {
		for (const listener of mock.onProxyErrorListeners) {
			listener({ error: "net::ERR_TUNNEL_CONNECTION_FAILED", details: "", fatal: true });
		}
	}

	it("while a check runs, more proxy errors share it: one probe", async () => {
		connected(mock);
		// the probe hangs, as one through a proxy that does not answer does
		let failProbe: (err: Error) => void = () => {};
		vi.stubGlobal("fetch", () => {
			probes++;
			return new Promise((_resolve, reject) => {
				failProbe = reject;
			});
		});
		await loadBackground();

		for (let i = 0; i < 20; i++) proxyError();
		await settle();
		expect(probes).toBe(1);

		failProbe(new Error("timed out"));
		await settle();
		expect(mock.getStored("proxy_health_failures")).toBe(1);
	});

	it("errors that keep coming after a failed check count once, and the proxy stays set", async () => {
		connected(mock);
		vi.stubGlobal("fetch", async () => {
			probes++;
			throw new Error("net::ERR_TUNNEL_CONNECTION_FAILED");
		});
		await loadBackground();

		// each page's request fails in turn, and so does each probe
		for (let i = 0; i < 6; i++) {
			proxyError();
			await settle();
		}

		expect(probes).toBe(1);
		expect(mock.getStored("proxy_health_failures")).toBe(1);
		// the kill switch is off: three failures would have taken the proxy off
		expect(mock.proxyValue()).toEqual(OUR_PROXY);
		expect(mock.getStored("proxy_health_report")).toBeUndefined();
	});
});

describe("requestHealthCheck", () => {
	let mock: ChromeMock;
	let health: typeof import("../src/utils/proxy-health");

	beforeEach(async () => {
		vi.resetModules();
		mock = installChromeMock();
		vi.doMock("../src/bridge/api", () => ({
			authNetworkClient: vi.fn(),
			removeNetworkClient: vi.fn(async () => true),
			activeProxyClientIds: vi.fn(async () => null),
			subscriptionBalance: vi.fn(async () => null),
		}));
		health = await import("../src/utils/proxy-health");
		connected(mock);
	});

	afterEach(() => {
		vi.doUnmock("../src/bridge/api");
	});

	it("keeps the schedule's timing: three failures take three checks a minute apart", async () => {
		let probes = 0;
		vi.stubGlobal("fetch", async () => {
			probes++;
			throw new Error("unreachable");
		});
		const schedule = minuteSchedule(health);
		const settings = health.defaultProxyHealthSettings();
		const request = (trigger: "scheduled" | "proxy_error") =>
			health.requestHealthCheck(trigger, () => {}, settings, schedule.now);

		expect(await request("proxy_error")).toBe("failing");
		// the rest of the burst, over the next 40 seconds
		for (let s = 0; s < 40; s += 5) {
			schedule.advance(5_000);
			expect(await request("proxy_error")).toBe("skipped");
		}
		expect(probes).toBe(1);

		// the schedule's checks count, a minute apart
		schedule.advance(20_000);
		expect(await request("scheduled")).toBe("failing");
		schedule.advance(60_000);
		const notify = vi.fn();
		expect(await health.requestHealthCheck("scheduled", notify, settings, schedule.now)).toBe("fell_back");
		expect(notify).toHaveBeenCalledWith("health");
		expect(probes).toBe(3);
	});

	it("a scheduled check right after a counted failure probes but does not count again", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("unreachable");
		});
		const schedule = minuteSchedule(health);
		const settings = health.defaultProxyHealthSettings();

		expect(await health.requestHealthCheck("proxy_error", () => {}, settings, schedule.now)).toBe("failing");
		schedule.advance(10_000);
		expect(await health.requestHealthCheck("scheduled", () => {}, settings, schedule.now)).toBe("failing");
		expect(mock.getStored("proxy_health_failures")).toBe(1);
	});

	it("a passing check starts the spacing afresh", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("unreachable");
		});
		const schedule = minuteSchedule(health);
		const settings = health.defaultProxyHealthSettings();
		expect(await health.requestHealthCheck("proxy_error", () => {}, settings, schedule.now)).toBe("failing");

		vi.stubGlobal("fetch", async () => ({ ok: true }));
		schedule.advance(60_000);
		expect(await health.requestHealthCheck("scheduled", () => {}, settings, schedule.now)).toBe("healthy");
		expect(mock.getStored("proxy_health_failed_at")).toBeUndefined();

		// the next proxy error checks at once again
		vi.stubGlobal("fetch", async () => {
			throw new Error("unreachable");
		});
		schedule.advance(1_000);
		expect(await health.requestHealthCheck("proxy_error", () => {}, settings, schedule.now)).toBe("failing");
	});
});
