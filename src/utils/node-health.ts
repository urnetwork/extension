import type { PacSlot } from "./pac-script";

export interface NodeHealth {
	host: string;
	port: number;
	latencyMs: number;
	alive: boolean;
	lastChecked: number;
}

const STORAGE_KEY = "node_health_results";
const HEALTH_CHECK_TIMEOUT_MS = 8_000;
const PING_URL = "https://api-v4.bringyour.com/my-ip-info";

async function checkNode(slot: PacSlot): Promise<NodeHealth> {
	const start = Date.now();
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

		const res = await fetch(PING_URL, { signal: controller.signal });
		clearTimeout(timeoutId);

		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		return {
			host: slot.host,
			port: slot.port,
			latencyMs: Date.now() - start,
			alive: true,
			lastChecked: Date.now(),
		};
	} catch {
		return {
			host: slot.host,
			port: slot.port,
			latencyMs: Date.now() - start,
			alive: false,
			lastChecked: Date.now(),
		};
	}
}

export async function runHealthCheck(slots: PacSlot[]): Promise<NodeHealth[]> {
	if (slots.length === 0) return [];

	const results = await Promise.all(slots.map(checkNode));
	await chrome.storage.local.set({ [STORAGE_KEY]: JSON.stringify(results) });
	return results;
}

// The order the slots should be in: the alive ones first, otherwise as they are.
//
// The browser's traffic follows the PAC list's first slot, so this order is the
// user's exit. checkNode fetches one url over whichever proxy is in use, not over
// the slot, so a latency says nothing about its slot, and sorting by them gave a
// new first slot, so a new exit, every pass. A dead proxy needs no sort to be left:
// the browser moves down the list by itself.
export function getSortedSlots(slots: PacSlot[], health: NodeHealth[]): PacSlot[] {
	const healthMap = new Map(health.map((h) => [`${h.host}:${h.port}`, h]));
	const alive = (slot: PacSlot) => healthMap.get(`${slot.host}:${slot.port}`)?.alive ?? false;

	// a stable sort, so slots that compare equal keep their order
	return [...slots].sort((a, b) => Number(alive(b)) - Number(alive(a)));
}

export function isSameSlotOrder(a: PacSlot[], b: PacSlot[]): boolean {
	return a.length === b.length && a.every((slot, i) => slot.host === b[i].host && slot.port === b[i].port);
}

export async function getStoredHealth(): Promise<NodeHealth[]> {
	const result = await chrome.storage.local.get(STORAGE_KEY);
	const raw = result[STORAGE_KEY] as string | undefined;
	if (!raw) return [];
	try {
		return JSON.parse(raw) as NodeHealth[];
	} catch {
		return [];
	}
}
