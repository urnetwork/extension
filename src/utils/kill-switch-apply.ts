import { buildPacScript, pacScriptToDataUrl, type PacSlot } from "./pac-script";
import { getSortedSlots, getStoredHealth } from "./node-health";
import { setKillSwitch } from "./kill-switch";
import { proxyManager } from "./proxy-manager";

const MULTI_IP_SLOTS_KEY = "multi_ip_slots";

function isFirefox(): boolean {
	return Boolean((globalThis as any).browser?.proxy?.onRequest);
}

// Persist + apply the kill-switch setting. Shared by the popup message handler
// and the app bridge so both surfaces change it identically. On Chrome in PAC
// (multi-IP) mode the PAC script encodes the kill switch, so it is regenerated.
export async function applyKillSwitchSetting(enabled: boolean): Promise<void> {
	await setKillSwitch(enabled);
	proxyManager.setKillSwitchState(enabled);

	const state = proxyManager.getState();
	if (state.enabled && state.mode === "pac" && !isFirefox()) {
		const stored = await chrome.storage.local.get(MULTI_IP_SLOTS_KEY);
		const raw = stored[MULTI_IP_SLOTS_KEY] as string | undefined;
		if (raw) {
			try {
				const slots = JSON.parse(raw) as PacSlot[];
				const health = await getStoredHealth();
				const sorted = getSortedSlots(slots, health);
				const pacScript = buildPacScript(sorted, { killSwitch: enabled });
				const dataUrl = pacScriptToDataUrl(pacScript);
				chrome.proxy.settings.set({
					value: { mode: "pac_script", pacScript: { url: dataUrl } },
					scope: "regular",
				});
			} catch {
				/* best effort */
			}
		}
	}
}
