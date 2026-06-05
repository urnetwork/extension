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

export function getSortedSlots(slots: PacSlot[], health: NodeHealth[]): PacSlot[] {
	const healthMap = new Map(health.map((h) => [`${h.host}:${h.port}`, h]));

	return [...slots].sort((a, b) => {
		const ha = healthMap.get(`${a.host}:${a.port}`);
		const hb = healthMap.get(`${b.host}:${b.port}`);

		// Alive nodes first
		const aliveA = ha?.alive ?? false;
		const aliveB = hb?.alive ?? false;
		if (aliveA !== aliveB) return aliveA ? -1 : 1;

		// Sort alive nodes by latency ascending
		const latA = ha?.latencyMs ?? Infinity;
		const latB = hb?.latencyMs ?? Infinity;
		return latA - latB;
	});
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
