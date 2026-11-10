// The popup's connect screen (popup/components/ConnectScreen.tsx), rendered to
// html with react-dom/server: the first render, before any effect has run,
// which is what the popup shows until its reads answer. The screen's hooks are
// replaced at the module boundary so each test chooses the connection's state:
// what the connection manager reports (utils/connection-manager.ts), an empty
// location list, and a signed-in user.
//
// - degraded (the kill switch keeps a proxy that does not answer): the popup
//   showed "Reconnecting..." with a spinner, in the status line and above the
//   button, while the reason the manager set was never shown, and nothing
//   reconnects (utils/proxy-health.ts). It now shows the reason, and the status
//   line says the proxy is not answering.
// - before the stored kill switch is read the toggle rendered on ("Blocks
//   traffic on failure"), though the setting is off unless turned on; the
//   location sync toggle rendered off whatever was stored. Neither toggle now
//   shows a state until its setting is read.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type FC } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { installChromeMock } from "./chrome-mock";
import type { ConnectionStatus } from "../src/utils/connection-manager";

const UNREACHABLE =
	"The proxy is not answering. The kill switch keeps the browser offline until it does.";
const LIMIT =
	"Your plan's limit of 5 active proxies is reached. Remove a proxy to create another, or upgrade to UR Pro for more.";

const connection: { status: ConnectionStatus; error: string | null } = { status: "idle", error: null };

vi.mock("@/utils/use-connection-manager", () => ({
	useConnectionManager: () => ({
		status: connection.status,
		error: connection.error,
		connect: async () => {},
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
// the message key stands in for its text
vi.mock("@/utils/i18n", () => ({ getMessage: (key: string) => key }));

let ConnectScreen: FC;

beforeAll(async () => {
	installChromeMock();
	({ ConnectScreen } = await import("../src/popup/components/ConnectScreen"));
});

beforeEach(() => {
	installChromeMock();
	connection.status = "idle";
	connection.error = null;
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

describe("popup connect screen", () => {
	it("the kill switch's degraded state shows why, and no reconnect", () => {
		connection.status = "degraded";
		connection.error = UNREACHABLE;

		const html = render();

		expect(html).toContain(UNREACHABLE);
		expect(html).toContain("Proxy not answering");
		expect(html).not.toContain("Reconnecting");
		// the browser is still set to the proxy: disconnecting is how to go direct
		expect(html).toContain("disconnect");
	});

	it("a refused connect shows the server's reason, with Retry", () => {
		connection.status = "error";
		connection.error = LIMIT;

		const html = render();

		expect(html).toContain(LIMIT);
		expect(html).toContain("retry");
		expect(html).toContain("Disconnected");
	});

	it("connected says so, with no notice", () => {
		connection.status = "connected";

		const html = render();

		expect(html).toContain("Connected");
		expect(html).not.toContain(UNREACHABLE);
		expect(html).not.toContain("Reconnecting");
	});

	it("before the stored settings are read, neither toggle shows a state", () => {
		const html = render();

		expect(html).not.toContain("Blocks traffic on failure");
		expect(html).not.toContain("Traffic may leak on failure");
		for (const label of ["Toggle kill switch", "sync_device_location_with_provider"]) {
			const tag = toggle(html, label);
			expect(tag).toContain('aria-busy="true"');
			expect(tag).toContain("disabled");
			expect(tag).not.toContain("aria-checked");
			// neither the on track nor a knob
			expect(tag).not.toContain("--ur-color-green");
		}
		expect(html).not.toContain("translateX");
	});
});
