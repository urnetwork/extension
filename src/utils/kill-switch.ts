const STORAGE_KEY = "kill_switch_enabled";

export async function getKillSwitch(): Promise<boolean> {
	const result = await chrome.storage.local.get(STORAGE_KEY);
	const value = result[STORAGE_KEY];
	// Default ON if never set
	return value === undefined ? true : Boolean(value);
}

export async function setKillSwitch(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}
