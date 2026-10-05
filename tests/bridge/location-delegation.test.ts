// A location picked in the popup while a ur.io tab is open is handed to the
// tab (APPLY_LOCATION) instead of reconnecting. Every tab records it as the
// page's newest location choice, so it carries the time it was made: a tab
// that runs it late (a frozen background tab) must not let it replace a
// choice made after it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, type BridgeHarness } from "./harness";

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
});
