import { setKillSwitch } from "./kill-switch";
import { proxyManager } from "./proxy-manager";

// Persist + apply the kill-switch setting. Shared by the popup message handler
// and the app bridge so both surfaces change it identically. Firefox's listener
// reads it on every request; on Chromium the health check reads it when the
// proxy stops answering (utils/proxy-health.ts), so nothing is re-applied here.
export async function applyKillSwitchSetting(enabled: boolean): Promise<void> {
	await setKillSwitch(enabled);
	proxyManager.setKillSwitchState(enabled);
}
