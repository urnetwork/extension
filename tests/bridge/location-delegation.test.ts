// A location picked in the popup while a ur.io tab is open is handed to the
// tab (APPLY_LOCATION) instead of reconnecting. Every tab records it as the
// page's newest location choice, so it carries the time it was made: a tab
// that runs it late (a frozen background tab) must not let it replace a
// choice made after it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./harness";

describe("popup location delegation", () => {
	let h: BridgeHarness;

	beforeEach(async () => {
		// only Date: the bridge's storage and alarm calls keep real timers
		vi.useFakeTimers({ toFake: ["Date"] });
		h = await createBridgeHarness();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a delegated pick carries the time the popup made it", async () => {
		await h.seedLiveSession();
		const page = h.connect("https://ur.io/app");

		vi.setSystemTime(1_000);
		await expect(
			h.bridge.handleExtensionLocationChange("synthetic-location-x", "Synthetic X"),
		).resolves.toEqual({ delegated: true });
		vi.setSystemTime(2_000);
		await expect(h.bridge.handleExtensionLocationChange(null)).resolves.toEqual({ delegated: true });

		expect(page.events.filter((event) => event.event === "APPLY_LOCATION")).toEqual([
			{
				dir: "event",
				event: "APPLY_LOCATION",
				payload: { locationId: "synthetic-location-x", name: "Synthetic X", pickedAt: 1_000 },
			},
			{
				dir: "event",
				event: "APPLY_LOCATION",
				payload: { locationId: null, name: null, pickedAt: 2_000 },
			},
		]);
	});

	// Only a session a page can attach a device to is delegated: the popup
	// reconnects any other itself, as it does when no ur.io tab is open.
	it("a popup pick for a multi-IP session is not delegated", async () => {
		h.chrome.seedStorage({ by_jwt: makeJwt({ network_id: NETWORK_ID }) });
		h.chrome.setProxyValue({ mode: "pac_script", pacScript: { data: "synthetic" } });
		const page = h.connect("https://ur.io/app");

		await expect(
			h.bridge.handleExtensionLocationChange("synthetic-location-x", "Synthetic X"),
		).resolves.toEqual({ delegated: false });
		expect(page.events.filter((event) => event.event === "APPLY_LOCATION")).toEqual([]);
		expect(h.chrome.storageData.has("selected_connect_location")).toBe(false);
	});

	it("a popup pick for a session without a hosted instance is not delegated", async () => {
		const { record } = await h.seedLiveSession();
		// a record from before the device endpoint was kept: no page can attach
		h.chrome.seedStorage({ bridge_session: { ...record, apiBaseUrl: null } });
		const page = h.connect("https://ur.io/app");

		await expect(
			h.bridge.handleExtensionLocationChange("synthetic-location-x", "Synthetic X"),
		).resolves.toEqual({ delegated: false });
		expect(page.events.filter((event) => event.event === "APPLY_LOCATION")).toEqual([]);
	});
});
