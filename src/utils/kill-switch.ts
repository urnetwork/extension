// The kill switch: whether the browser stops (on) or goes direct (off) when
// the install's proxy stops answering (utils/proxy-health.ts). Off unless the
// user turns it on (owner product setting, 2026-10-02).
const STORAGE_KEY = "kill_switch_enabled";

export async function getKillSwitch(): Promise<boolean> {
	const result = await chrome.storage.local.get(STORAGE_KEY);
	const value = result[STORAGE_KEY];
	return value === undefined ? false : Boolean(value);
}

export async function setKillSwitch(enabled: boolean): Promise<void> {
	await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}
