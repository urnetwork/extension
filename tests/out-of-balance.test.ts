// Out of data (A, owner approval 2026-11-11: as the apps do). With the kill
// switch off, its default, a browser whose account ran out of data dropped to
// a direct connection within about three minutes: the proxy carries nothing
// without data, so the health check's probe failed three times and the check
// took the proxy off (utils/proxy-health.ts), as for a proxy that does not
// answer. The apps never disconnect for it: an automatic disconnect can leak
// traffic, so they alert, post a local notification, and leave disconnecting
// to the user (owner, 2026-10-02). A failed check now reads the account
// balance, and with no data left it keeps the proxy set whatever the kill
// switch says, tells the popup (the out-of-data alert), and posts one browser
// notification per episode where the browser allows it. Other failures keep
// the documented behaviour.
//
// The notification's permission is optional, and only the popup's Turn on
// alerts asks for it (owner, 2026-11-11, utils/alerts-permission.ts): the
// background never does. Without it, a "!" on the toolbar icon is the alert
// with the popup closed; the badge shows with the permission too. Taken back
// during an episode, the permission granted again posts the episode's
// notification anew.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { message, SYSTEM_PROXY } from "./chrome-mock";
import { minuteSchedule, type MinuteSchedule } from "./health-schedule";

// the server's contract floor (utils/out-of-balance.ts OUT_OF_DATA_BYTES)
const OUT_OF_DATA_BYTES = 1024 * 1024;

const JWT = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const OUT_OF_DATA = { balanceByteCount: 0, pro: false };
const DATA_LEFT = { balanceByteCount: 5 * 1024 * 1024 * 1024, pro: false };

function provisioned(n: number) {
	return {
		by_client_jwt: makeJwt({ client_id: `client-${n}` }),
		proxy_config_result: {
			auth_token: `SIGNED${n}`,
			instance_id: `aaaaaaaa-bbbb-cccc-dddd-${n.toString(16).padStart(12, "0")}`,
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
		},
	};
}

const OUR_PROXY = {
	mode: "fixed_servers",
	rules: { singleProxy: { scheme: "https", host: "SIGNED1.proxy.example.ur", port: 8443 } },
};

type Notifications = {
	create: ReturnType<typeof vi.fn>;
	clear: ReturnType<typeof vi.fn>;
	// the permissions API's request, which only the popup's Turn on alerts calls
	request: ReturnType<typeof vi.fn>;
	// the user grants the permission, or takes it back in the browser's settings
	setGranted: (granted: boolean) => void;
};

// what the toolbar badge's calls take (chrome.action)
type BadgeText = { text: string };
type BadgeColor = { color: string };

describe("out of data", () => {
	let h: BridgeHarness;
	let health: typeof import("../src/utils/proxy-health");
	let schedule: MinuteSchedule;

	const popupReports = () =>
		h.chrome.runtimeMessages.filter((m) => (m as { type?: string }).type === "PROXY_HEALTH");

	// the browser lets the extension post notifications, or not
	function allowNotifications(granted: boolean): Notifications {
		const permission = { granted };
		const notifications = {
			create: vi.fn(async (id: string) => id),
			clear: vi.fn(async () => true),
		};
		const request = vi.fn(async () => permission.granted);
		Object.assign(h.chrome.chrome, {
			permissions: { contains: vi.fn(async () => permission.granted), request },
			notifications,
		});
		return {
			...notifications,
			request,
			setGranted: (next: boolean) => {
				permission.granted = next;
			},
		};
	}

	// the extension's toolbar icon, whose badge the episode sets
	function toolbarBadge() {
		const action = {
			setBadgeText: vi.fn<(details: BadgeText) => Promise<void>>(async () => {}),
			setBadgeBackgroundColor: vi.fn<(details: BadgeColor) => Promise<void>>(async () => {}),
			setBadgeTextColor: vi.fn<(details: BadgeColor) => Promise<void>>(async () => {}),
		};
		Object.assign(h.chrome.chrome, { action });
		return {
			action,
			// the badge's text as last set; undefined if it was never set
			text: () => action.setBadgeText.mock.calls.at(-1)?.[0].text,
		};
	}

	beforeEach(async () => {
		h = await createBridgeHarness();
		health = await import("../src/utils/proxy-health");
		schedule = minuteSchedule(health);
		h.chrome.seedStorage({ by_jwt: JWT, network_name: "testnet" });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
		h.api.subscriptionBalance.mockImplementation(async () => OUT_OF_DATA);
		await h.bridge.connectFromPopup(undefined);
		h.chrome.resetCalls();
	});

	afterEach(() => {
		delete (globalThis as { browser?: unknown }).browser;
	});

	it("kill switch off: the proxy stays set however long it lasts", async () => {
		const outcomes = [];
		for (let i = 0; i < 6; i++) outcomes.push(await schedule.check());

		expect(outcomes).toEqual(Array(6).fill("out_of_balance"));
		expect(h.chrome.proxyValue()).toMatchObject(OUR_PROXY);
		expect(h.chrome.proxySettingsClearCalls).toHaveLength(0);
		expect(h.chrome.getStored("proxy_health_report")).toBe("out_of_balance");
		expect(h.chrome.getStored("proxy_out_of_balance")).toMatchObject({ plan: "free" });
		expect(popupReports()).toContainEqual({ type: "PROXY_HEALTH", outcome: "out_of_balance", plan: "free" });
		expect(popupReports()).not.toContainEqual(expect.objectContaining({ outcome: "fell_back" }));
		// the balance was asked with the network's jwt
		expect(h.api.subscriptionBalance).toHaveBeenCalledWith(JWT);
	});

	it("kill switch on: the alert, not the kill switch's state", async () => {
		h.chrome.seedStorage({ kill_switch_enabled: true });

		for (let i = 0; i < 4; i++) expect(await schedule.check()).toBe("out_of_balance");

		expect(h.chrome.getStored("proxy_health_report")).toBe("out_of_balance");
		expect(h.chrome.proxyValue()).toMatchObject(OUR_PROXY);
	});

	it("Pro at its plan's data", async () => {
		h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: 1024, pro: true }));

		expect(await schedule.check()).toBe("out_of_balance");

		expect(h.chrome.getStored("proxy_out_of_balance")).toMatchObject({ plan: "pro" });
		expect(popupReports()).toContainEqual({ type: "PROXY_HEALTH", outcome: "out_of_balance", plan: "pro" });
	});

	it("just under the server's 1 MiB contract floor is out of data; at it, not", async () => {
		h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: OUT_OF_DATA_BYTES - 1, pro: false }));
		expect(await schedule.check()).toBe("out_of_balance");

		h.api.subscriptionBalance.mockImplementation(async () => ({ balanceByteCount: OUT_OF_DATA_BYTES, pro: false }));
		expect(await schedule.check()).toBe("failing");
	});

	it("one notification per episode, where the browser allows it", async () => {
		const notifications = allowNotifications(true);

		for (let i = 0; i < 4; i++) await schedule.check();

		expect(notifications.create).toHaveBeenCalledTimes(1);
		expect(notifications.create.mock.calls[0][0]).toBe("urnetwork-out-of-data");
		expect(notifications.create.mock.calls[0][1]).toMatchObject({
			type: "basic",
			title: message("insufficient_balance"),
		});
		expect(notifications.create.mock.calls[0][1].message).toContain(message("extension_out_of_data_held"));

		// data is back: the episode ends, and its notification goes
		vi.stubGlobal("fetch", async () => ({ ok: true }));
		expect(await schedule.check()).toBe("healthy");
		expect(notifications.clear).toHaveBeenCalledWith("urnetwork-out-of-data");

		// the next episode notifies again
		vi.stubGlobal("fetch", async () => {
			throw new Error("refused");
		});
		await schedule.check();
		expect(notifications.create).toHaveBeenCalledTimes(2);
	});

	it("no notification where the browser does not allow it, and none asked for", async () => {
		const notifications = allowNotifications(false);

		for (let i = 0; i < 3; i++) await schedule.check();

		expect(notifications.create).not.toHaveBeenCalled();
		// only the user's click in the popup asks (utils/alerts-permission.ts)
		expect(notifications.request).not.toHaveBeenCalled();
		expect(h.chrome.getStored("proxy_out_of_balance")).toMatchObject({ notified: false });
		expect(h.chrome.getStored("proxy_health_report")).toBe("out_of_balance");
	});

	it("alerts turned on during the episode: its notification is posted", async () => {
		const notifications = allowNotifications(false);
		await schedule.check();
		expect(notifications.create).not.toHaveBeenCalled();

		// Turn on alerts in the popup
		notifications.setGranted(true);
		expect(await schedule.check()).toBe("out_of_balance");

		expect(notifications.create).toHaveBeenCalledTimes(1);
		expect(h.chrome.getStored("proxy_out_of_balance")).toMatchObject({ notified: true });
		await schedule.check();
		expect(notifications.create).toHaveBeenCalledTimes(1);
	});

	it("the permission taken back during the episode: turned on again, the episode notifies anew", async () => {
		const notifications = allowNotifications(true);
		await schedule.check();
		expect(notifications.create).toHaveBeenCalledTimes(1);

		// taken back in the browser's settings: nothing is posted meanwhile
		notifications.setGranted(false);
		expect(await schedule.check()).toBe("out_of_balance");
		expect(notifications.create).toHaveBeenCalledTimes(1);
		expect(h.chrome.getStored("proxy_out_of_balance")).toMatchObject({ notified: false });
		expect(h.chrome.getStored("proxy_health_report")).toBe("out_of_balance");

		// and turned on again in the popup
		notifications.setGranted(true);
		await schedule.check();
		expect(notifications.create).toHaveBeenCalledTimes(2);
		expect(h.chrome.getStored("proxy_out_of_balance")).toMatchObject({ notified: true });
		expect(notifications.request).not.toHaveBeenCalled();
	});

	it("the toolbar badge shows the episode, without the permission and with it, and goes with it", async () => {
		const badge = toolbarBadge();
		const notifications = allowNotifications(false);

		expect(await schedule.check()).toBe("out_of_balance");
		expect(badge.text()).toBe("!");
		expect(badge.action.setBadgeBackgroundColor).toHaveBeenCalled();

		notifications.setGranted(true);
		await schedule.check();
		expect(notifications.create).toHaveBeenCalledTimes(1);
		expect(badge.text()).toBe("!");

		// data is back: the episode ends, and the badge goes
		vi.stubGlobal("fetch", async () => ({ ok: true }));
		expect(await schedule.check()).toBe("healthy");
		expect(badge.text()).toBe("");
	});

	it("a disconnect takes the badge off", async () => {
		const badge = toolbarBadge();
		await schedule.check();
		expect(badge.text()).toBe("!");

		await h.bridge.disconnectFromPopup();

		expect(badge.text()).toBe("");
	});

	it("no badge while data is left", async () => {
		const badge = toolbarBadge();
		h.api.subscriptionBalance.mockImplementation(async () => DATA_LEFT);

		expect(await schedule.check()).toBe("failing");

		expect(badge.text()).toBeUndefined();
	});

	it("a balance that does not come back keeps the episode", async () => {
		await schedule.check();
		h.api.subscriptionBalance.mockImplementation(async () => null);

		for (let i = 0; i < 4; i++) expect(await schedule.check()).toBe("out_of_balance");

		expect(h.chrome.proxyValue()).toMatchObject(OUR_PROXY);
	});

	it("data back while the proxy still does not answer: the documented fallback, counted afresh", async () => {
		await schedule.check();
		h.api.subscriptionBalance.mockImplementation(async () => DATA_LEFT);

		expect(await schedule.check()).toBe("failing");
		expect(h.chrome.getStored("proxy_out_of_balance")).toBeUndefined();
		expect(await schedule.check()).toBe("failing");
		expect(await schedule.check()).toBe("fell_back");
		expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
	});

	it("a proxy that does not answer with data left keeps the documented fallback", async () => {
		h.api.subscriptionBalance.mockImplementation(async () => DATA_LEFT);

		const outcomes = [];
		for (let i = 0; i < 3; i++) outcomes.push(await schedule.check());

		expect(outcomes).toEqual(["failing", "failing", "fell_back"]);
		expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
	});

	it("a balance that does not come back, with no episode, keeps the documented fallback", async () => {
		h.api.subscriptionBalance.mockImplementation(async () => null);

		for (let i = 0; i < 2; i++) await schedule.check();

		expect(await schedule.check()).toBe("fell_back");
	});

	it("a disconnect or a connect ends the episode and its notification", async () => {
		const notifications = allowNotifications(true);
		await schedule.check();

		await h.bridge.disconnectFromPopup();

		expect(h.chrome.getStored("proxy_out_of_balance")).toBeUndefined();
		expect(h.chrome.getStored("proxy_health_report")).toBeUndefined();
		expect(notifications.clear).toHaveBeenCalledWith("urnetwork-out-of-data");

		await h.bridge.connectFromPopup(undefined);
		await schedule.check();
		await h.bridge.connectFromPopup(undefined);
		expect(h.chrome.getStored("proxy_out_of_balance")).toBeUndefined();
	});

	it("Firefox: no request goes direct while it lasts, even with the kill switch off", async () => {
		const listeners: Array<(details: { url: string }) => unknown> = [];
		(globalThis as { browser?: unknown }).browser = {
			proxy: {
				onRequest: {
					addListener: (listener: (details: { url: string }) => unknown) => listeners.push(listener),
					removeListener: (listener: (details: { url: string }) => unknown) => {
						const index = listeners.indexOf(listener);
						if (0 <= index) listeners.splice(index, 1);
					},
					hasListener: (listener: (details: { url: string }) => unknown) => listeners.includes(listener),
				},
			},
		};
		await h.bridge.connectFromPopup(undefined);
		const proxy = { type: "https", host: "SIGNED1.proxy.example.ur", port: 8443, failoverTimeout: 5 };
		expect(listeners[0]({ url: "https://example.com/" })).toEqual([proxy, { type: "direct" }]);

		expect(await schedule.check()).toBe("out_of_balance");
		expect(listeners[0]({ url: "https://example.com/" })).toEqual([proxy]);

		// data is back
		vi.stubGlobal("fetch", async () => ({ ok: true }));
		expect(await schedule.check()).toBe("healthy");
		expect(listeners[0]({ url: "https://example.com/" })).toEqual([proxy, { type: "direct" }]);
	});

	it("Firefox: a restarted background holds the traffic from the episode it kept", async () => {
		await schedule.check();
		const { proxyManager } = await import("../src/utils/proxy-manager");
		proxyManager.setTrafficHold(false);

		await proxyManager.restoreState();

		expect(proxyManager.isTrafficHeld()).toBe(true);
	});
});
