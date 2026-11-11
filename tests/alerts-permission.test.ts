// Turn on alerts (owner, 2026-11-11: "accept recommendation a"). The
// out-of-data notification's permission is optional and was never asked for,
// so the notification was posted only where a user had granted it some other
// way. The popup now asks for it when the user presses Turn on alerts
// (utils/alerts-permission.ts):
// - Firefox grants a permissions.request only from inside a user input
//   handler, so the request must go out in the click itself, with nothing
//   awaited before it;
// - a refusal, or a browser that throws, leaves it not granted;
// - the button is offered only where the manifest makes the permission
//   optional and the browser can ask;
// - the permission can be granted or taken back later (Firefox's add-on
//   settings remove it at any time), and the popup follows both.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import {
	concernsNotifications,
	notificationsGranted,
	notificationsRequestable,
	requestNotifications,
	watchNotificationsPermission,
} from "../src/utils/alerts-permission";

type PermissionsListener = (permissions: chrome.permissions.Permissions) => void;

function listenerRegistry() {
	const listeners: PermissionsListener[] = [];
	return {
		listeners,
		event: {
			addListener: (listener: PermissionsListener) => listeners.push(listener),
			removeListener: (listener: PermissionsListener) => {
				const index = listeners.indexOf(listener);
				if (0 <= index) listeners.splice(index, 1);
			},
		},
		fire: (permissions: chrome.permissions.Permissions) => {
			for (const listener of [...listeners]) listener(permissions);
		},
	};
}

// the browser's permissions API, with the notifications permission granted or not
function installPermissions(mock: ChromeMock, granted: boolean) {
	const state = { granted };
	const added = listenerRegistry();
	const removed = listenerRegistry();
	const api = {
		contains: vi.fn(async () => state.granted),
		request: vi.fn(async () => {
			state.granted = true;
			return true;
		}),
		onAdded: added.event,
		onRemoved: removed.event,
	};
	Object.assign(mock.chrome, { permissions: api });
	return { state, api, added, removed };
}

function offerOptionalNotifications(mock: ChromeMock, optional: string[] = ["notifications"]) {
	Object.assign(mock.chrome.runtime, {
		getManifest: () => ({ version: "0.0.0-test", optional_permissions: optional }),
	});
}

// lets pending promise callbacks run
const settle = async () => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};

const NOTIFICATIONS = { permissions: ["notifications"] } as chrome.permissions.Permissions;

describe("Turn on alerts", () => {
	let mock: ChromeMock;

	beforeEach(() => {
		mock = installChromeMock();
	});

	it("the request goes out in the click itself, before anything is awaited", async () => {
		const { api } = installPermissions(mock, false);

		const granted = requestNotifications();

		// nothing has been awaited yet: the call is still inside the click
		expect(api.request).toHaveBeenCalledTimes(1);
		expect(api.request).toHaveBeenCalledWith({ permissions: ["notifications"] });
		expect(await granted).toBe(true);
	});

	it("a refusal, a rejected request or one that throws is not granted", async () => {
		const { api } = installPermissions(mock, false);

		api.request.mockImplementationOnce(async () => false);
		expect(await requestNotifications()).toBe(false);

		api.request.mockImplementationOnce(async () => {
			throw new Error("permissions.request may only be called from a user input handler");
		});
		expect(await requestNotifications()).toBe(false);

		api.request.mockImplementationOnce(() => {
			throw new Error("not a user gesture");
		});
		expect(await requestNotifications()).toBe(false);
	});

	it("offered only where the manifest makes it optional and the browser can ask", () => {
		// the chrome mock's manifest offers no optional permission, and there
		// is no permissions API
		expect(notificationsRequestable()).toBe(false);

		offerOptionalNotifications(mock);
		expect(notificationsRequestable()).toBe(false);

		installPermissions(mock, false);
		expect(notificationsRequestable()).toBe(true);

		offerOptionalNotifications(mock, []);
		expect(notificationsRequestable()).toBe(false);
	});

	it("granted is what the browser says, and false where it cannot say", async () => {
		expect(await notificationsGranted()).toBe(false);

		const { state, api } = installPermissions(mock, true);
		expect(await notificationsGranted()).toBe(true);
		expect(api.contains).toHaveBeenCalledWith({ permissions: ["notifications"] });

		state.granted = false;
		expect(await notificationsGranted()).toBe(false);

		api.contains.mockImplementationOnce(async () => {
			throw new Error("gone");
		});
		expect(await notificationsGranted()).toBe(false);
	});

	it("the popup follows a grant and a removal, and no other permission", async () => {
		const { added, removed } = installPermissions(mock, false);
		const seen: boolean[] = [];

		const stop = watchNotificationsPermission((granted) => seen.push(granted));
		await settle();
		expect(seen).toEqual([false]);

		added.fire(NOTIFICATIONS);
		expect(seen).toEqual([false, true]);

		// another permission is not this one
		added.fire({ permissions: ["tabs"] } as chrome.permissions.Permissions);
		removed.fire({ origins: ["https://example.com/*"] });
		expect(seen).toEqual([false, true]);

		// taken back later, in the browser's settings
		removed.fire(NOTIFICATIONS);
		expect(seen).toEqual([false, true, false]);

		stop();
		expect(added.listeners).toHaveLength(0);
		expect(removed.listeners).toHaveLength(0);
	});

	it("a grant while the first read is out wins over that read", async () => {
		const { api, added } = installPermissions(mock, false);
		let answer: (granted: boolean) => void = () => {};
		api.contains.mockImplementationOnce(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		);
		const seen: boolean[] = [];

		watchNotificationsPermission((granted) => seen.push(granted));
		added.fire(NOTIFICATIONS);
		// the read answers what it saw before the grant
		answer(false);
		await settle();

		expect(seen).toEqual([true]);
	});

	it("an event names the permission it is about", () => {
		expect(concernsNotifications(NOTIFICATIONS)).toBe(true);
		expect(concernsNotifications({ permissions: ["tabs"] } as chrome.permissions.Permissions)).toBe(false);
		expect(concernsNotifications({})).toBe(false);
		expect(concernsNotifications(undefined)).toBe(false);
	});
});
