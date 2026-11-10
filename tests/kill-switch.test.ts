// The kill switch setting (utils/kill-switch.ts): off unless the user turned it
// on, and read the same way by the background and the popup's toggle.
// watchKillSwitch reports it once read and on every change after, so the toggle
// renders the stored value; until the first report the toggle shows neither
// state (tests/popup-connect-screen.test.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { getKillSwitch, setKillSwitch, watchKillSwitch } from "../src/utils/kill-switch";

// every pending storage read answers before the next macrotask
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("kill switch setting", () => {
	let mock: ChromeMock;

	beforeEach(() => {
		mock = installChromeMock();
	});

	function change(changes: Record<string, chrome.storage.StorageChange>, area = "local") {
		for (const listener of [...mock.onStorageChangedListeners]) listener(changes, area);
	}

	it("is off unless turned on", async () => {
		expect(await getKillSwitch()).toBe(false);
		await setKillSwitch(true);
		expect(await getKillSwitch()).toBe(true);
	});

	it("the watch reports the stored value once read: off when unset", async () => {
		const seen: boolean[] = [];
		watchKillSwitch((enabled) => seen.push(enabled));
		expect(seen).toEqual([]);
		await settle();
		expect(seen).toEqual([false]);
	});

	it("the watch reports a stored on", async () => {
		mock.seedStorage({ kill_switch_enabled: true });
		const seen: boolean[] = [];
		watchKillSwitch((enabled) => seen.push(enabled));
		await settle();
		expect(seen).toEqual([true]);
	});

	it("the watch reports each change, and a change before the read answers wins", async () => {
		mock.seedStorage({ kill_switch_enabled: true });
		const seen: boolean[] = [];
		const stop = watchKillSwitch((enabled) => seen.push(enabled));

		// a ur.io tab turns it off over the bridge before the read answers
		change({ kill_switch_enabled: { oldValue: true, newValue: false } });
		await settle();
		expect(seen).toEqual([false]);

		change({ kill_switch_enabled: { oldValue: false, newValue: true } });
		change({ other_key: { newValue: false } });
		change({ kill_switch_enabled: { newValue: false } }, "sync");
		expect(seen).toEqual([false, true]);

		stop();
		expect(mock.onStorageChangedListeners).toHaveLength(0);
	});

	it("a stopped watch reports nothing, not even the read", async () => {
		const seen: boolean[] = [];
		watchKillSwitch((enabled) => seen.push(enabled))();
		await settle();
		expect(seen).toEqual([]);
	});
});
