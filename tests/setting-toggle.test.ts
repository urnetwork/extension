// The popup's toggles for stored settings (B7, owner approval 2026-11-11). The
// kill switch toggle was optimistic: it showed the new value, sent
// SET_KILL_SWITCH and ignored the answer, so when the background could not
// save it the toggle kept a setting the extension did not have until the popup
// was reopened, and said nothing. The location sync toggle did the same with
// its storage write. Both now go through toggleSetting
// (popup/components/ConnectScreen.tsx), which puts the toggle back and says so
// when the save fails.
import { describe, expect, it } from "vitest";
import { toggleSetting, type SettingToggleState } from "../src/utils/setting-toggle";

const OFF: SettingToggleState = { value: false, saving: false, failed: false };

describe("a setting toggle", () => {
	it("a save the background refuses puts the toggle back, and says so", async () => {
		const shown: SettingToggleState[] = [];

		// background/index.ts answers SET_KILL_SWITCH { success: false } on a
		// storage error
		const done = await toggleSetting(OFF, async () => false, (state) => shown.push(state));

		expect(shown).toEqual([
			{ value: true, saving: true, failed: false },
			{ value: false, saving: false, failed: true },
		]);
		expect(done).toEqual({ value: false, saving: false, failed: true });
	});

	it("a save that throws (no background to answer) puts it back too", async () => {
		const done = await toggleSetting(
			{ value: true, saving: false, failed: false },
			async () => {
				throw new Error("Could not establish connection. Receiving end does not exist.");
			},
			() => {},
		);

		expect(done).toEqual({ value: true, saving: false, failed: true });
	});

	it("a save that succeeds keeps the new value, and ends an earlier failure", async () => {
		const shown: SettingToggleState[] = [];

		const done = await toggleSetting(
			{ value: false, saving: false, failed: true },
			async (next) => next === true,
			(state) => shown.push(state),
		);

		expect(done).toEqual({ value: true, saving: false, failed: false });
		expect(shown[0]).toEqual({ value: true, saving: true, failed: false });
	});

	it("does nothing before the setting is read, or while a change is saved", async () => {
		const saves: boolean[] = [];
		const save = async (next: boolean) => {
			saves.push(next);
			return true;
		};

		await toggleSetting({ value: null, saving: false, failed: false }, save, () => {});
		await toggleSetting({ value: true, saving: true, failed: false }, save, () => {});

		expect(saves).toEqual([]);
	});
});
