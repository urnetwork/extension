// The kill switch: whether the browser stops (on) or goes direct (off) when
// the install's proxy stops answering (utils/proxy-health.ts). Off unless the
// user turns it on (owner product setting, 2026-10-02).
const STORAGE_KEY = "kill_switch_enabled";

function storedValue(value: unknown): boolean {
	return value === undefined ? false : Boolean(value);
}

export async function getKillSwitch(): Promise<boolean> {
	const result = await chrome.storage.local.get(STORAGE_KEY);
	return storedValue(result[STORAGE_KEY]);
}

export async function setKillSwitch(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}

/**
 * Reports the stored setting, read the way the background reads it, and every
 * change to it after that (the popup's toggle, or a ur.io tab over the bridge),
 * until the returned function stops it. The popup shows the toggle in neither
 * state until the first report. A change that lands before the first read
 * answers is newer than that read, which is then dropped.
 */
export function watchKillSwitch(onValue: (enabled: boolean) => void): () => void {
	let stopped = false;
	let changed = false;
	const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (stopped || area !== "local" || !(STORAGE_KEY in changes)) return;
		changed = true;
		onValue(storedValue(changes[STORAGE_KEY].newValue));
	};
	chrome.storage.onChanged.addListener(onChanged);
	getKillSwitch().then(
		(enabled) => {
			if (!stopped && !changed) onValue(enabled);
		},
		(err) => console.error("Failed to read the kill switch:", err),
	);
	return () => {
		stopped = true;
		chrome.storage.onChanged.removeListener(onChanged);
	};
}
