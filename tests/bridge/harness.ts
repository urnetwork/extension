// Test harness for the app content-channel bridge (src/bridge/background.ts).
//
// The bridge is exercised through its real wire contract, not by reaching into
// internals: initBridge() registers its chrome.runtime.onConnect listener on
// the chrome mock, tests attach a fake Port with a chosen sender origin, and
// requests flow as PortRequestFrames exactly as content.ts would send them.
// That way origin gating, frame validation, and the res/error frame shapes are
// all under test, and adding coverage for another verb is one request() call.
//
// Module isolation: background.ts (and the proxyManager singleton it imports)
// holds module-level state — the ports set, the serialize() op chain, the
// proxy state cache. Each harness resets the module registry and re-imports,
// so every test starts from a cold service worker, mirroring how MV3 actually
// restarts the background service.
//
// The api module (src/bridge/api.ts) is replaced with vi.fn()s at the module
// boundary: it is the only network surface the bridge has, and mocking it both
// keeps the suite offline and lets tests assert provisioning/release calls —
// including that REFRESH_JWT makes none at all.
import { vi } from "vitest";
import { installChromeMock, type ChromeMock } from "../chrome-mock";
import type * as BackgroundModule from "../../src/bridge/background";
import type {
	BridgeAuthClientResult,
} from "../../src/bridge/api";
import type { BridgeSessionRecord } from "../../src/bridge/session";
import { BRIDGE_PORT_NAME } from "../../src/bridge/protocol";

export { BRIDGE_PORT_NAME };

// Must match background.ts (private there; pinned here — the alarm name is
// durable state in the user's browser, so a silent rename should break tests).
export const RENEW_ALARM = "urn-bridge-session-renew";

// ---- jwt fabrication -------------------------------------------------------

function base64UrlEncode(value: string): string {
	return Buffer.from(value, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** An unsigned but structurally valid jwt — the extension is decode-only. */
export function makeJwt(claims: Record<string, unknown>): string {
	const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
	const payload = base64UrlEncode(JSON.stringify(claims));
	return `${header}.${payload}.test-signature`;
}

// ---- fake port -------------------------------------------------------------

export type ResponseFrame = {
	dir: "res";
	id: string | number;
	ok: boolean;
	data?: unknown;
	error?: string;
	code?: string;
};

export type EventFrame = { dir: "event"; event: string; payload: unknown };

export type FakePort = {
	port: chrome.runtime.Port;
	/** true once the SERVICE called port.disconnect() (origin rejection) */
	disconnectedByService: boolean;
	/** message listeners the service registered — empty means it never accepted the port */
	messageListenerCount: () => number;
	/** all event frames broadcast to this port so far */
	events: EventFrame[];
	/** send a request frame and await the matching response frame */
	request: (verb: string, payload?: Record<string, unknown>) => Promise<ResponseFrame>;
	/** simulate the page side going away */
	disconnectFromClient: () => void;
};

let nextRequestId = 1;

function createFakePort(url: string | undefined, name: string): FakePort {
	const messageListeners: Array<(msg: unknown) => void> = [];
	const disconnectListeners: Array<() => void> = [];
	const events: EventFrame[] = [];
	const pending = new Map<string | number, (frame: ResponseFrame) => void>();

	const fake: FakePort = {
		disconnectedByService: false,
		events,
		messageListenerCount: () => messageListeners.length,
		port: {
			name,
			sender: url === undefined ? {} : { url },
			onMessage: {
				addListener: (listener: (msg: unknown) => void) => {
					messageListeners.push(listener);
				},
			},
			onDisconnect: {
				addListener: (listener: () => void) => {
					disconnectListeners.push(listener);
				},
			},
			postMessage: (msg: ResponseFrame | EventFrame) => {
				if (msg.dir === "event") {
					events.push(msg);
					return;
				}
				const resolve = pending.get(msg.id);
				if (resolve) {
					pending.delete(msg.id);
					resolve(msg);
				}
			},
			disconnect: () => {
				fake.disconnectedByService = true;
			},
		} as unknown as chrome.runtime.Port,
		request: (verb, payload) => {
			const id = `t-${nextRequestId++}`;
			return new Promise<ResponseFrame>((resolve, reject) => {
				pending.set(id, resolve);
				if (messageListeners.length === 0) {
					reject(
						new Error(
							`no message listener on port (origin rejected?) — cannot deliver ${verb}`,
						),
					);
					return;
				}
				for (const listener of messageListeners) {
					listener({ id, verb, payload });
				}
			});
		},
		disconnectFromClient: () => {
			for (const listener of disconnectListeners) listener();
		},
	};
	return fake;
}

// ---- harness ---------------------------------------------------------------

export type BridgeHarness = {
	chrome: ChromeMock;
	bridge: typeof BackgroundModule;
	api: {
		authNetworkClient: ReturnType<typeof vi.fn>;
		removeNetworkClient: ReturnType<typeof vi.fn>;
	};
	/** attach a page port through the service's real onConnect listener;
	 * pass url: null for a port whose sender has no url at all */
	connect: (url?: string | null, name?: string) => FakePort;
	/** seed storage + proxy + alarm to look like a live standard session */
	seedLiveSession: (options?: { jwt?: string }) => Promise<LiveSessionSeed>;
};

export type LiveSessionSeed = {
	jwt: string;
	record: BridgeSessionRecord;
	proxyHostLabel: string;
};

export const NETWORK_ID = "network-1";
export const OTHER_NETWORK_ID = "network-2";

export async function createBridgeHarness(): Promise<BridgeHarness> {
	vi.resetModules();
	const chromeMock = installChromeMock();

	const authNetworkClient = vi.fn(
		async (): Promise<BridgeAuthClientResult> => ({
			proxy_config_result: null,
			error: { message: "authNetworkClient not mocked for this test" },
		}),
	);
	const removeNetworkClient = vi.fn(async (): Promise<unknown> => ({}));
	vi.doMock("../../src/bridge/api", () => ({
		authNetworkClient,
		removeNetworkClient,
	}));

	const bridge = await import("../../src/bridge/background");
	bridge.initBridge();

	return {
		chrome: chromeMock,
		bridge,
		api: { authNetworkClient, removeNetworkClient },
		connect: (url = "https://ur.io/app", name = BRIDGE_PORT_NAME) => {
			const fake = createFakePort(url ?? undefined, name);
			for (const listener of chromeMock.onConnectListeners) {
				listener(fake.port);
			}
			return fake;
		},
		seedLiveSession: async (options) => {
			const jwt =
				options?.jwt ??
				makeJwt({
					network_id: NETWORK_ID,
					network_name: "testnet",
					user_id: "user-1",
				});
			const record: BridgeSessionRecord = {
				clientId: "client-old",
				signedProxyId: "signedproxyid",
				proxyHost: "proxy.example.ur",
				httpsProxyPort: 8443,
				apiBaseUrl: "https://api.proxy.example.ur:8444",
				expirationTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				locationId: null,
			};
			const proxyHostLabel = `${record.signedProxyId}.${record.proxyHost}`;

			chromeMock.setProxyValue({
				mode: "fixed_servers",
				rules: {
					singleProxy: {
						scheme: "https",
						host: proxyHostLabel,
						port: record.httpsProxyPort,
					},
				},
			});
			chromeMock.seedStorage({
				by_jwt: jwt,
				network_name: "testnet",
				bridge_session: record,
				proxy_enabled: true,
				proxy_config: {
					host: proxyHostLabel,
					port: record.httpsProxyPort,
					scheme: "https",
				},
				proxy_client_id: record.clientId,
			});
			chromeMock.alarms.set(RENEW_ALARM, { when: Date.now() + 30 * 60 * 1000 });

			// tests assert on activity AFTER the seed
			chromeMock.resetCalls();
			return { jwt, record, proxyHostLabel };
		},
	};
}
