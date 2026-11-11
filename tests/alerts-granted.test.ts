// Turn on alerts during an out-of-data episode (owner, 2026-11-11). The popup
// asks for the notifications permission on the user's click, and it can close
// while the browser asks, so a grant is acted on by the background: its
// permissions.onAdded listener (background/index.ts) starts a check, which
// posts the episode's notification at once rather than at the next scheduled
// check. Another permission starts nothing.
//
// The real background entry point is loaded on the chrome mock, so the
// browser's events arrive as the browser delivers them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { makeJwt, NETWORK_ID } from "./bridge/harness";

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const OUR_PROXY = {
	mode: "fixed_servers",
	rules: { singleProxy: { scheme: "https", host: "SIGNED1.proxy.example.ur", port: 8443 } },
};
const NOTIFICATIONS = { permissions: ["notifications"] } as chrome.permissions.Permissions;

type PermissionsListener = (permissions: chrome.permissions.Permissions) => void;

// lets every pending storage read and probe settle
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function connected(mock: ChromeMock) {
	mock.setProxyValue(OUR_PROXY);
	mock.seedStorage({
		by_jwt: JWT,
		proxy_enabled: true,
		proxy_config: { host: "SIGNED1.proxy.example.ur", port: 8443, scheme: "https" },
		proxy_client_id: "client-1",
	});
}

describe("alerts turned on during an out-of-data episode", () => {
	let mock: ChromeMock;
	let probes: number;
	const permission = { granted: false };
	const onAdded: PermissionsListener[] = [];
	const notifications = {
		create: vi.fn(async (id: string) => id),
		clear: vi.fn(async () => true),
	};

	beforeEach(async () => {
		vi.resetModules();
		mock = installChromeMock();
		probes = 0;
		permission.granted = false;
		onAdded.length = 0;
		notifications.create = vi.fn(async (id: string) => id);
		notifications.clear = vi.fn(async () => true);
		Object.assign(mock.chrome, {
			permissions: {
				contains: vi.fn(async () => permission.granted),
				request: vi.fn(async () => false),
				onAdded: { addListener: (listener: PermissionsListener) => onAdded.push(listener) },
				onRemoved: { addListener: () => {} },
			},
			notifications,
		});
		// the account has no data left
		vi.doMock("../src/bridge/api", () => ({
			authNetworkClient: vi.fn(),
			removeNetworkClient: vi.fn(async () => true),
			activeProxyClientIds: vi.fn(async () => null),
			subscriptionBalance: vi.fn(async () => ({ balanceByteCount: 0, pro: false })),
		}));
		// the background's start (restore after 2 s) never runs here
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		// the proxy carries nothing: every probe fails
		vi.stubGlobal("fetch", async () => {
			probes++;
			throw new Error("net::ERR_TUNNEL_CONNECTION_FAILED");
		});
		connected(mock);
		await import("../src/background/index");
		expect(onAdded).toHaveLength(1);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("../src/bridge/api");
	});

	function scheduledCheck() {
		for (const listener of mock.onAlarmListeners) listener({ name: "node-health-check", scheduledTime: 0 });
	}

	function grant(permissions: chrome.permissions.Permissions) {
		permission.granted = permission.granted || permissions.permissions?.includes("notifications") === true;
		for (const listener of onAdded) listener(permissions);
	}

	it("the grant posts the episode's notification at once, and asks nothing", async () => {
		scheduledCheck();
		await settle();
		expect(mock.getStored("proxy_out_of_balance")).toMatchObject({ notified: false });
		expect(notifications.create).not.toHaveBeenCalled();

		grant(NOTIFICATIONS);
		await settle();

		expect(notifications.create).toHaveBeenCalledTimes(1);
		expect(notifications.create.mock.calls[0][0]).toBe("urnetwork-out-of-data");
		expect(mock.getStored("proxy_out_of_balance")).toMatchObject({ notified: true });
		// the proxy still holds the traffic: nothing disconnected
		expect(mock.proxyValue()).toEqual(OUR_PROXY);
		expect(mock.chrome.permissions.request).not.toHaveBeenCalled();
	});

	it("another permission starts no check", async () => {
		grant({ permissions: ["tabs"] } as chrome.permissions.Permissions);
		await settle();

		expect(probes).toBe(0);
		expect(notifications.create).not.toHaveBeenCalled();
	});
});
