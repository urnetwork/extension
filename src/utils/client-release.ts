// Releasing the hosted proxy clients the extension provisions
// (POST /network/remove-client), shared by the popup's connection manager
// (utils/connection-manager.ts) and the background bridge (bridge/background.ts).
//
// A client that is never removed stays active on the server until its idle
// reap, about 30 days after its last use, and counts all that time against
// the network's cap of active proxies (free 5, Pro 1000). So a client is
// written down from the moment it exists until a remove-client call for it
// succeeds:
// - provisioned but not yet applied, it is pending: a popup closed mid-connect
//   ends its page, and the next pass releases the client instead of the page
//   taking its id away with it;
// - replaced or disconnected, it is pending until its release succeeds. A
//   failed release (offline, a server error) stays pending and every later
//   pass retries it, up to `maxAttempts` passes in all.
// A pass never releases a client the caller names live (the applied pool or
// the bridge session), and drops a live client from the list.
//
// The popup and the background service worker both read and write the list
// with no lock between them (chrome.storage has no compare-and-set): two
// passes at the same moment can lose one's write, which leaves at worst that
// one client to the server's idle reap, as before this list existed.
import { chromeStorageAdapter } from "./storage-adapter";

export const STORAGE_KEY_PENDING_RELEASE_CLIENTS = "pending_release_clients";

export type ClientReleaseSettings = {
	// passes that may try to release one client before it is left to the
	// server's idle reap; non-positive keeps nothing pending after a pass
	maxAttempts: number;
};

export function defaultClientReleaseSettings(): ClientReleaseSettings {
	return {
		// a pass runs on each connect, reconnect, renewal and disconnect, so ten
		// spans a few days of ordinary use, and a client the server will never
		// release (removed already, or another network's) stops being retried
		maxAttempts: 10,
	};
}

// Resolves true when the client is released or the server has nothing to
// release; false (or a rejection) keeps it pending for a later pass.
export type ReleaseClientFn = (clientId: string) => Promise<boolean>;

type PendingReleaseClient = { clientId: string; attempts: number };

async function loadPendingReleaseClients(): Promise<PendingReleaseClient[]> {
	const raw = await chromeStorageAdapter.getItem(STORAGE_KEY_PENDING_RELEASE_CLIENTS);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(entry): entry is PendingReleaseClient =>
				typeof entry?.clientId === "string" &&
				entry.clientId !== "" &&
				typeof entry.attempts === "number",
		);
	} catch {
		return [];
	}
}

async function storePendingReleaseClients(pending: PendingReleaseClient[]): Promise<void> {
	if (pending.length === 0) {
		await chromeStorageAdapter.removeItem(STORAGE_KEY_PENDING_RELEASE_CLIENTS);
		return;
	}
	await chromeStorageAdapter.setItem(STORAGE_KEY_PENDING_RELEASE_CLIENTS, JSON.stringify(pending));
}

/** The clients still waiting for a remove-client call, by id. */
export async function pendingReleaseClientIds(): Promise<string[]> {
	return (await loadPendingReleaseClients()).map((entry) => entry.clientId);
}

/** Writes clients down as pending release without releasing them yet. */
export async function addPendingReleaseClients(clientIds: string[]): Promise<void> {
	if (clientIds.length === 0) return;
	const pending = await loadPendingReleaseClients();
	const known = new Set(pending.map((entry) => entry.clientId));
	for (const clientId of clientIds) {
		if (clientId && !known.has(clientId)) {
			pending.push({ clientId, attempts: 0 });
			known.add(clientId);
		}
	}
	await storePendingReleaseClients(pending);
}

/** Takes clients off the list: they are applied and live now. */
export async function removePendingReleaseClients(clientIds: string[]): Promise<void> {
	if (clientIds.length === 0) return;
	const live = new Set(clientIds);
	const pending = await loadPendingReleaseClients();
	await storePendingReleaseClients(pending.filter((entry) => !live.has(entry.clientId)));
}

/**
 * Releases `clientIds` and every client already pending, except
 * `liveClientIds`. A client whose release fails stays pending with the
 * attempt counted, until `settings.maxAttempts`.
 */
export async function releaseClients(
	clientIds: string[],
	liveClientIds: string[],
	release: ReleaseClientFn,
	settings: ClientReleaseSettings = defaultClientReleaseSettings(),
): Promise<void> {
	const live = new Set(liveClientIds);
	const attemptsByClientId = new Map<string, number>();
	for (const entry of await loadPendingReleaseClients()) {
		attemptsByClientId.set(entry.clientId, entry.attempts);
	}
	for (const clientId of clientIds) {
		if (clientId && !attemptsByClientId.has(clientId)) {
			attemptsByClientId.set(clientId, 0);
		}
	}
	const candidates = [...attemptsByClientId.entries()].filter(([clientId]) => !live.has(clientId));
	if (candidates.length === 0 && attemptsByClientId.size === 0) return;

	const outcomes = await Promise.all(
		candidates.map(async ([clientId, attempts]) => {
			let released = false;
			try {
				released = await release(clientId);
			} catch {
				released = false;
			}
			return { clientId, attempts: attempts + 1, released };
		}),
	);
	await storePendingReleaseClients(
		outcomes
			.filter((outcome) => !outcome.released && outcome.attempts < settings.maxAttempts)
			.map((outcome) => ({ clientId: outcome.clientId, attempts: outcome.attempts })),
	);
}
