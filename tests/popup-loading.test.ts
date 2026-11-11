// The popup as it opens (B5, owner approval 2026-11-11), with the real
// connection hook (utils/use-connection-manager.ts): its first render, before
// the background has answered GET_VPN_STATE. The hook started at "idle", so
// every popup opened showing Disconnected and Connect, also over a proxy that
// was set, until the answer came. It now starts loading: no status words, and
// a neutral, disabled button in place of Connect or Disconnect.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement, type FC } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { installChromeMock, message } from "./chrome-mock";

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

let ConnectScreen: FC;

beforeAll(async () => {
	installChromeMock();
	({ ConnectScreen } = await import("../src/popup/components/ConnectScreen"));
});

describe("a popup that opens", () => {
	it("shows no connection state before the background answers", () => {
		installChromeMock();

		const html = renderToString(createElement(MemoryRouter, null, createElement(ConnectScreen)));

		expect(html).not.toContain(message("disconnected"));
		expect(html).not.toMatch(new RegExp(`<ur-text[^>]*>${message("connect")}</ur-text>`));
		expect(html).not.toMatch(new RegExp(`<ur-text[^>]*>${message("disconnect")}</ur-text>`));
		expect(html).toContain('data-testid="connection-loading"');
	});
});
