// The browser's traffic follows the PAC list's first slot, so the order of the
// slots is the user's exit. The per-minute health pass fetches one url over
// whichever proxy is in use, once per slot, so its latencies compare nothing
// about the slots. Sorting by them shuffled the list every minute: a new exit, a
// new IP and a proxy reconfiguration every minute, which reads to the user as the
// extension disconnecting all the time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";

const SLOTS = [
	{ host: "a.proxy.example", port: 443 },
	{ host: "b.proxy.example", port: 443 },
	{ host: "c.proxy.example", port: 443 },
];

function health(host: string, latencyMs: number, alive: boolean) {
	return { host, port: 443, latencyMs, alive, lastChecked: 0 };
}

describe("getSortedSlots", () => {
	it("keeps the order of alive slots whatever their latencies", async () => {
		const { getSortedSlots } = await import("../src/utils/node-health");
		const sorted = getSortedSlots(SLOTS, [
			health("a.proxy.example", 900, true),
			health("b.proxy.example", 120, true),
			health("c.proxy.example", 40, true),
		]);
		expect(sorted).toEqual(SLOTS);
	});

	it("moves a slot that failed behind the alive ones, in order", async () => {
		const { getSortedSlots } = await import("../src/utils/node-health");
		const sorted = getSortedSlots(SLOTS, [
			health("a.proxy.example", 8000, false),
			health("b.proxy.example", 900, true),
			health("c.proxy.example", 40, true),
		]);
		expect(sorted).toEqual([SLOTS[1], SLOTS[2], SLOTS[0]]);
	});

	it("keeps the order when every slot failed", async () => {
		const { getSortedSlots } = await import("../src/utils/node-health");
		const sorted = getSortedSlots(SLOTS, [
			health("a.proxy.example", 8000, false),
			health("b.proxy.example", 10, false),
			health("c.proxy.example", 400, false),
		]);
		expect(sorted).toEqual(SLOTS);
	});
});

describe("performHealthCheck", () => {
	let browser: ChromeMock;

	beforeEach(() => {
		vi.resetModules();
		browser = installChromeMock();
		browser.seedStorage({ multi_ip_slots: JSON.stringify(SLOTS) });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	// a pass whose fetches answer `ok`, each taking a different time by the clock
	async function runPass(ok: boolean) {
		const { proxyManager } = await import("../src/utils/proxy-manager");
		proxyManager.syncState({ enabled: true, mode: "pac", config: null });
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => {
			now += 137;
			return now;
		});
		vi.stubGlobal("fetch", vi.fn(async () => {
			if (!ok) throw new Error("no route");
			return { ok: true } as Response;
		}));
		const { performHealthCheck } = await import("../src/utils/node-health-pass");
		await performHealthCheck();
	}

	it("leaves the proxy settings alone while the order stands", async () => {
		await runPass(true);
		expect(browser.proxySettingsSetCalls).toHaveLength(0);
		expect(browser.getStored("multi_ip_slots")).toBe(JSON.stringify(SLOTS));
	});

	it("leaves the proxy settings alone when the shared route fails", async () => {
		await runPass(false);
		expect(browser.proxySettingsSetCalls).toHaveLength(0);
	});

	it("applies a new order when a slot failed and others did not", async () => {
		const { proxyManager } = await import("../src/utils/proxy-manager");
		proxyManager.syncState({ enabled: true, mode: "pac", config: null });
		let call = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			call += 1;
			if (call === 1) throw new Error("no route");
			return { ok: true } as Response;
		}));
		const { performHealthCheck } = await import("../src/utils/node-health-pass");
		await performHealthCheck();
		expect(browser.proxySettingsSetCalls).toHaveLength(1);
		expect(browser.getStored("multi_ip_slots")).toBe(JSON.stringify([SLOTS[1], SLOTS[2], SLOTS[0]]));
	});
});
