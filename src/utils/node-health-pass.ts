import { proxyManager } from "./proxy-manager";
import { buildPacScript, pacScriptToDataUrl, type PacSlot } from "./pac-script";
import { runHealthCheck, getSortedSlots, isSameSlotOrder } from "./node-health";
import { getKillSwitch } from "./kill-switch";
import type { FirefoxGlobal } from "../types/firefox-webext";

const MULTI_IP_SLOTS_KEY = "multi_ip_slots";

function isFirefox(): boolean {
	return Boolean((globalThis as FirefoxGlobal).browser?.proxy?.onRequest);
}

export async function performHealthCheck(): Promise<void> {
	const state = proxyManager.getState();

	// Firefox defensive check: if storage says we should be connected but the
	// onRequest listener is no longer active (background was terminated and
	// restarted), re-run restoreState() to re-register the listener immediately,
	// then return early. The next alarm tick (up to 1 minute) will run the full
	// health-check pass with fresh in-memory state.
	if (isFirefox() && !proxyManager.isListenerActive()) {
		const stored = await chrome.storage.local.get("proxy_enabled");
		if (stored["proxy_enabled"]) {
			await proxyManager.restoreState();
			return;
		}
	}

	if (!state.enabled || state.mode !== "pac") return;

	const result = await chrome.storage.local.get(MULTI_IP_SLOTS_KEY);
	const raw = result[MULTI_IP_SLOTS_KEY] as string | undefined;
	if (!raw) return;

	let slots: PacSlot[];
	try {
		slots = JSON.parse(raw) as PacSlot[];
	} catch {
		return;
	}

	if (slots.length === 0) return;

	const health = await runHealthCheck(slots);
	const sorted = getSortedSlots(slots, health);

	// a re-set with nothing new would still make the browser reload its proxy
	// configuration, and a Firefox listener would be replaced for nothing
	if (isSameSlotOrder(sorted, slots)) return;

	if (isFirefox()) {
		proxyManager.enableMultiIp(sorted);
	} else {
		const killSwitch = await getKillSwitch();
		const pacScript = buildPacScript(sorted, { killSwitch });
		const dataUrl = pacScriptToDataUrl(pacScript);

		chrome.proxy.settings.set({
			value: { mode: "pac_script", pacScript: { url: dataUrl } },
			scope: "regular",
		});
	}

	await chrome.storage.local.set({ [MULTI_IP_SLOTS_KEY]: JSON.stringify(sorted) });
}
