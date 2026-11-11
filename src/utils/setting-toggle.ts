// A popup toggle for a stored setting (popup/components/ConnectScreen.tsx: the
// kill switch and location sync). The toggle shows the new value while the
// change is saved, and goes back to the value before it, saying why, when the
// save fails: the background could not store the kill switch, or storage
// refused location sync. A toggle that kept the new value would show a
// setting the extension does not have until the popup was reopened.

export type SettingToggleState = {
	// the value shown; null until the stored value is read
	value: boolean | null;
	// a change is being saved: the toggle takes no other until it is
	saving: boolean;
	// the last change could not be saved, and the toggle went back
	failed: boolean;
};

/**
 * Toggles `state.value`, saving the new value with `save` (which resolves
 * whether it was saved, or rejects), and reports each state to `onState`:
 * the new value at once, then either the saved value or, when the save
 * failed, the value before with `failed`. A toggle before the value is read,
 * or while a change is being saved, does nothing.
 */
export async function toggleSetting(
	state: SettingToggleState,
	save: (next: boolean) => Promise<boolean>,
	onState: (state: SettingToggleState) => void,
): Promise<SettingToggleState> {
	if (state.value === null || state.saving) return state;
	const previous = state.value;
	const next = !previous;
	onState({ value: next, saving: true, failed: false });
	let saved = false;
	try {
		saved = await save(next);
	} catch {
		saved = false;
	}
	const done: SettingToggleState = saved
		? { value: next, saving: false, failed: false }
		: { value: previous, saving: false, failed: true };
	onState(done);
	return done;
}
