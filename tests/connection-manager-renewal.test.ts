// Nothing renews the install's one hosted proxy client: the server never
// expires a hosted proxy (its ProxyClient has no expiration), and the client
// is kept for the life of the install (bridge/background.ts). The popup's pool
// used to re-provision itself at 70-80% of its first slot's lifetime; a popup
// left open now sends one connect, however long it stays open and whatever
// expiration the server reports. Driven with every timer and the clock under
// test control.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, type BridgeHarness } from "./bridge/harness";
import { ConnectionManager } from "../src/utils/connection-manager";
import type { ConnectLocation } from "../src/utils/sdk-types";

const T0 = Date.UTC(2026, 10, 1, 12);
const MINUTE = 60 * 1_000;
const DAY = 24 * 60 * MINUTE;

describe("no renewal", () => {
	let h: BridgeHarness;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		h = await createBridgeHarness();
		h.chrome.seedStorage({ by_jwt: makeJwt({ network_id: NETWORK_ID }) });
		h.api.authNetworkClient.mockImplementation(async () => ({
			by_client_jwt: makeJwt({ client_id: "00000000-0000-4000-8000-000000000001" }),
			proxy_config_result: {
				auth_token: "SIGNED1",
				instance_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				proxy_host: "proxy.example.ur",
				https_proxy_port: 8443,
				api_base_url: "https://api.proxy.example.ur:8444",
				// even a short expiration renews nothing
				expiration_time: new Date(T0 + 10 * MINUTE).toISOString(),
			},
		}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a popup left open for days sends one connect and provisions one client", async () => {
		const sent: string[] = [];
		const manager = new ConnectionManager(
			{ onStatusChange: () => {}, onProxyChange: () => {}, onError: () => {} },
			async (message) => {
				sent.push(String(message.type));
				const outcome = await h.bridge.connectFromPopup(
					(message.location ?? undefined) as ConnectLocation | undefined,
				);
				return { success: outcome.ok };
			},
		);

		await manager.connect();
		await vi.advanceTimersByTimeAsync(3 * DAY);

		expect(manager.getStatus()).toBe("connected");
		expect(sent).toEqual(["POPUP_CONNECT"]);
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(h.chrome.alarmCreateCalls).toEqual([]);
		manager.destroy();
	});
});
