// The popup's connect screen (popup/components/ConnectScreen.tsx), rendered to
// html with react-dom/server: the first render, before any effect has run,
// which is what the popup shows until its reads answer. The screen's hooks are
// replaced at the module boundary so each test chooses the connection's state:
// what the connection manager reports (utils/connection-manager.ts), an empty
// location list, and a signed-in user. Its text comes from the extension's
// generated catalogs (public/_locales, through the chrome mock's i18n).
//
// - degraded (the kill switch keeps a proxy that does not answer): the popup
//   showed "Reconnecting..." with a spinner, in the status line and above the
//   button, while the reason the manager set was never shown, and nothing
//   reconnects (utils/proxy-health.ts). It shows the reason, and the status
//   line says the proxy is not answering.
// - before the stored kill switch is read the toggle rendered on ("Blocks
//   traffic on failure"), though the setting is off unless turned on; the
//   location sync toggle rendered off whatever was stored. Neither toggle now
//   shows a state until its setting is read.
//
// Owner approval 2026-11-11:
// - a location change that failed with the previous proxy still set showed
//   Disconnected and Connect (B3): it shows Connected, the reason, and
//   Disconnect;
// - out of data shows the out-of-data alert (A);
// - another extension, or policy, holding the proxy setting says so (B2);
// - the status labels and messages were English in every language (B6).
//
// Owner, 2026-11-11 ("accept recommendation a"): the out-of-data
// notification's permission is optional and was never asked for. While the
// browser can be asked and has not granted it, the screen offers Turn on
// alerts: in the out-of-data alert while that shows, under the settings
// toggles otherwise, and nowhere once granted.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FC } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { installChromeMock, message, type ChromeMock } from "./chrome-mock";
import type {
	BlockedProxy,
	ConnectionStatus,
	OutOfBalanceAlert,
} from "../src/utils/connection-manager";
import type { AlertsPermission } from "../src/utils/use-alerts-permission";

const LIMIT =
	"Your plan's limit of 5 active proxies is reached. Remove a proxy to create another, or upgrade to UR Pro for more.";
const NO_PROVIDERS = "No providers are available at that location.";

const connection: {
	status: ConnectionStatus;
	error: string | null;
	outOfBalance: OutOfBalanceAlert | null;
	blocked: BlockedProxy | null;
} = { status: "idle", error: null, outOfBalance: null, blocked: null };

vi.mock("@/utils/use-connection-manager", () => ({
	useConnectionManager: () => ({
		status: connection.status,
		error: connection.error,
		outOfBalance: connection.outOfBalance,
		blocked: connection.blocked,
		connect: async () => "connected",
		disconnect: async () => {},
		endSession: async () => {},
		reattach: async () => {},
		onProxyChange: () => {},
	}),
}));
vi.mock("@/utils/use-provider-list-enhanced", () => ({
	useProviderListEnhanced: () => ({
		query: "",
		setQuery: () => {},
		filteredLocations: {},
		error: null,
		loading: true,
		retry: () => {},
	}),
}));
vi.mock("@urnetwork/sdk/react", () => ({ useAuth: () => ({ clearAuth: () => {} }) }));
// the notifications permission as the screen's hook reports it
const alerts: { permission: AlertsPermission } = { permission: "unread" };
vi.mock("@/utils/use-alerts-permission", () => ({
	useAlertsPermission: () => ({ permission: alerts.permission, requesting: false, turnOn: () => {} }),
}));

let ConnectScreen: FC;
let mock: ChromeMock;

beforeAll(async () => {
	installChromeMock();
	({ ConnectScreen } = await import("../src/popup/components/ConnectScreen"));
});

beforeEach(() => {
	mock = installChromeMock();
	connection.status = "idle";
	connection.error = null;
	connection.outOfBalance = null;
	connection.blocked = null;
	alerts.permission = "unread";
});

// the html with the entities react-dom/server escapes text with decoded
function render(): string {
	return renderToString(createElement(MemoryRouter, null, createElement(ConnectScreen)))
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

// the opening tag of the toggle labelled `label`
function toggle(html: string, label: string): string {
	const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0];
	expect(tag, `no toggle labelled ${label}`).toBeDefined();
	return tag ?? "";
}

// the text of each of the screen's buttons
function buttons(html: string): string[] {
	return [...html.matchAll(/<ur-button[^>]*>([\s\S]*?)<\/ur-button>/g)].map((m) =>
		m[1].replace(/<[^>]*>/g, "").trim(),
	);
}

// the status line at the popup's foot
function statusLine(html: string): string {
	return html.match(/data-testid="connection-status"[^>]*>([^<]*)</)?.[1] ?? "";
}

// a link's href by its text
function link(html: string, text: string): string | undefined {
	return html.match(new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${text}</a>`))?.[1];
}

// how many times html carries a marker
function count(html: string, marker: string): number {
	return html.split(marker).length - 1;
}

const TURN_ON_ALERTS = 'data-testid="turn-on-alerts"';
const TURN_ON_ALERTS_ROW = 'data-testid="turn-on-alerts-row"';

describe("popup connect screen", () => {
	it("the kill switch's degraded state shows why, and no reconnect", () => {
		connection.status = "degraded";

		const html = render();

		expect(html).toContain("The proxy is not answering. The kill switch keeps the browser offline until it does.");
		expect(statusLine(html)).toBe("Proxy not answering");
		expect(html).not.toContain("Reconnecting");
		// the browser is still set to the proxy: disconnecting is how to leave it
		expect(buttons(html)).toContain("Disconnect");
	});

	it("a refused connect shows the server's reason, with Retry", () => {
		connection.status = "error";
		connection.error = LIMIT;

		const html = render();

		expect(html).toContain(LIMIT);
		expect(buttons(html)).toEqual(expect.arrayContaining(["Connect", "Retry"]));
		expect(statusLine(html)).toBe("Disconnected");
	});

	it("connected says so, with no notice", () => {
		connection.status = "connected";

		const html = render();

		expect(statusLine(html)).toBe("Connected");
		expect(html).not.toContain("The proxy is not answering");
		expect(html).not.toContain("Reconnecting");
		expect(html).not.toContain(message("extension_location_unchanged"));
	});

	it("a location change that failed with the previous proxy still set: Connected, the reason, Disconnect", () => {
		connection.status = "connected";
		connection.error = NO_PROVIDERS;

		const html = render();

		expect(buttons(html)).toContain("Disconnect");
		expect(buttons(html)).not.toContain("Connect");
		expect(html).toContain(NO_PROVIDERS);
		expect(html).toContain("The browser is still connected at the previous location.");
		expect(statusLine(html)).toBe("Connected");
	});

	it("before the stored settings are read, neither toggle shows a state", () => {
		const html = render();

		expect(html).not.toContain("Blocks traffic on failure");
		expect(html).not.toContain("Traffic may leak on failure");
		for (const label of ["Kill switch", message("sync_device_location_with_provider")]) {
			const tag = toggle(html, label);
			expect(tag).toContain('aria-busy="true"');
			expect(tag).toContain("disabled");
			expect(tag).not.toContain("aria-checked");
			// neither the on track nor a knob
			expect(tag).not.toContain("--ur-color-green");
		}
		expect(html).not.toContain("translateX");
	});

	it("before the background answers: neither Connect nor Disconnect, and no status", () => {
		connection.status = "loading";

		const html = render();

		expect(html).toContain('data-testid="connection-loading"');
		expect(buttons(html).filter((text) => text === "Connect" || text === "Disconnect")).toEqual([]);
		expect(statusLine(html).trim()).toBe("");
		expect(html).not.toContain("Disconnected");
	});

	describe("out of data", () => {
		beforeEach(() => {
			// 18:47:30 UTC: the free refresh is 5 h 13 min away
			vi.useFakeTimers({ now: Date.parse("2026-11-11T18:47:30Z"), toFake: ["Date"] });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("the free plan: when free data refreshes, Get Pro and Buy data on ur.io, and Disconnect", () => {
			connection.status = "out_of_balance";
			connection.outOfBalance = { plan: "free", held: true };

			const html = render();

			expect(statusLine(html)).toBe("Insufficient balance");
			expect(html).toContain("Free data refreshes in 5h 13m.");
			expect(html).toContain("Pages won't load in this browser until data is available or you disconnect.");
			expect(html).toContain("To upgrade, press Disconnect first. Payment can't get through until you do.");
			expect(link(html, "Get Pro")).toBe("https://ur.io/app/offer");
			expect(link(html, "Buy data")).toBe("https://ur.io/buy-data");
			expect(buttons(html)).toContain("Disconnect");
			expect(buttons(html)).not.toContain("Connect");
		});

		it("Pro at its data: when it renews, and Buy data, never Get Pro", () => {
			connection.status = "out_of_balance";
			connection.outOfBalance = { plan: "pro", held: true };

			const html = render();

			expect(statusLine(html)).toBe("Data limit reached");
			expect(html).toContain(message("site_data_limit_pro"));
			expect(html).toContain("To buy data, press Disconnect first. Payment can't get through until you do.");
			expect(link(html, "Buy data")).toBe("https://ur.io/buy-data");
			expect(link(html, "Get Pro")).toBeUndefined();
		});

		it("after the user disconnected: the links stay, and Connect", () => {
			connection.status = "idle";
			connection.outOfBalance = { plan: "free", held: false };

			const html = render();

			expect(statusLine(html)).toBe("Disconnected");
			expect(link(html, "Get Pro")).toBe("https://ur.io/app/offer");
			expect(html).not.toContain("press Disconnect first");
			expect(html).not.toContain("Pages won't load");
			expect(buttons(html)).toContain("Connect");
		});
	});

	describe("Turn on alerts", () => {
		it("not granted: offered under the settings toggles, with what it is for", () => {
			alerts.permission = "not_granted";
			connection.status = "connected";

			const html = render();

			expect(count(html, TURN_ON_ALERTS)).toBe(1);
			expect(count(html, TURN_ON_ALERTS_ROW)).toBe(1);
			expect(html).toContain(">Turn on alerts</button>");
			expect(html).toContain("Get a notification when your data runs out.");
			// below the toggles
			expect(html.indexOf(TURN_ON_ALERTS_ROW)).toBeGreaterThan(html.indexOf('aria-label="Kill switch"'));
		});

		it("granted, not read yet, or a browser that cannot be asked: not offered", () => {
			connection.status = "connected";
			for (const permission of ["granted", "unread", "unavailable"] as const) {
				alerts.permission = permission;

				const html = render();

				expect(count(html, TURN_ON_ALERTS), permission).toBe(0);
				expect(html, permission).not.toContain("Get a notification when your data runs out.");
			}
		});

		it("out of data and not granted: in the alert beside its links, and only there", () => {
			alerts.permission = "not_granted";
			connection.status = "out_of_balance";
			connection.outOfBalance = { plan: "free", held: true };

			const html = render();

			expect(count(html, TURN_ON_ALERTS)).toBe(1);
			expect(count(html, TURN_ON_ALERTS_ROW)).toBe(0);
			const notice = html.indexOf('data-testid="out-of-data-notice"');
			const buyData = html.indexOf('href="https://ur.io/buy-data"');
			expect(notice).toBeGreaterThanOrEqual(0);
			expect(html.indexOf(TURN_ON_ALERTS)).toBeGreaterThan(buyData);
			expect(html.indexOf(TURN_ON_ALERTS)).toBeLessThan(html.indexOf('aria-label="Kill switch"'));
		});

		it("out of data and granted: the alert as it was", () => {
			alerts.permission = "granted";
			connection.status = "out_of_balance";
			connection.outOfBalance = { plan: "pro", held: true };

			const html = render();

			expect(count(html, TURN_ON_ALERTS)).toBe(0);
			expect(link(html, "Buy data")).toBe("https://ur.io/buy-data");
		});

		it("in the browser's language", () => {
			mock.setLocale("de");
			alerts.permission = "not_granted";
			connection.status = "idle";

			const html = render();

			expect(html).toContain(`>${message("extension_turn_on_alerts", "de")}</button>`);
			expect(html).toContain(message("extension_out_of_data_alerts_note", "de"));
			expect(html).not.toContain("Turn on alerts");
		});
	});

	describe("another extension, or policy, holds the proxy setting", () => {
		it("another extension: says so, with Disconnect for the extension's own value under it", () => {
			connection.status = "blocked";
			connection.blocked = { control: "other_extension", intent: true };

			const html = render();

			expect(statusLine(html)).toBe("Another extension controls the proxy");
			expect(html).toContain(message("extension_proxy_other_extension"));
			expect(buttons(html)).toContain("Disconnect");
			expect(statusLine(html)).not.toBe("Connected");
		});

		it("with nothing of the extension's under it: Connect, which says why if it still holds", () => {
			connection.status = "blocked";
			connection.blocked = { control: "other_extension", intent: false };

			expect(buttons(render())).toContain("Connect");
		});

		it("policy", () => {
			connection.status = "blocked";
			connection.blocked = { control: "policy", intent: false };

			const html = render();

			expect(statusLine(html)).toBe("Proxy managed by policy");
			expect(html).toContain(message("extension_proxy_policy"));
		});
	});

	it("speaks the browser's language: German, with no English status or message left", () => {
		mock.setLocale("de");
		const german = (key: string) => message(key, "de");
		const english = [
			"Proxy not answering",
			"The proxy is not answering. The kill switch keeps the browser offline until it does.",
			"Blocks traffic on failure",
			"Traffic may leak on failure",
			// German writes the kill switch as English does, so its label is no tell
			"Logout",
			"Search countries, cities, regions...",
		];

		connection.status = "degraded";
		const degraded = render();
		for (const text of english) expect(degraded).not.toContain(text);
		expect(degraded).toContain(german("extension_proxy_unreachable_kill_switch"));
		expect(degraded).toContain(german("sign_out"));
		expect(degraded).toContain(german("kill_switch"));
		expect(statusLine(degraded)).toBe(german("extension_status_proxy_not_answering"));

		for (const [status, key] of [
			["connected", "connected"],
			["idle", "disconnected"],
			["connecting", "site_app_connecting"],
		] as const) {
			connection.status = status;
			expect(statusLine(render())).toBe(german(key));
		}
	});
});
