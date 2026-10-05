// The popup connects with no ur.io tab attached to any of its sessions, so the
// connect options must ride on every slot's provisioning or the slots run in
// Auto (rotating exits) whatever Fixed IP said.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { makeJwt, NETWORK_ID } from "./bridge/harness";
import { ConnectionManager } from "../src/utils/connection-manager";
import { parsePerformanceProfile, storePerformanceProfile } from "../src/utils/performance-profile";
import type { ConnectLocation } from "../src/utils/sdk-types";
import { FIXED_IP_STREAMING, wireProfile, wireWindow } from "./performance-profiles";

type AuthNetworkClient = ConstructorParameters<typeof ConnectionManager>[0];

describe("popup connect", () => {
	let browser: ChromeMock;

	beforeEach(() => {
		browser = installChromeMock();
		browser.seedStorage({ by_jwt: makeJwt({ network_id: NETWORK_ID }) });
	});

	// the profile each slot's auth-client call provisioned its hosted device with
	async function connectSlots() {
		const authNetworkClient = vi.fn<AuthNetworkClient>(async () => ({
			proxy_config_result: null,
			error: { message: "no capacity in this test", client_limit_exceeded: false },
		}));
		const manager = new ConnectionManager(authNetworkClient, async () => ({}), {
			onStatusChange: () => {},
			onProxyChange: () => {},
			onError: () => {},
		});
		const location = { connect_location_id: { location_id: "location-1" } } as ConnectLocation;
		await manager.connect(location);
		manager.destroy();
		return authNetworkClient.mock.calls.map(
			([args]) => args.proxy_config?.initial_device_state?.performance_profile,
		);
	}

	it("provisions every slot with the kept connect options", async () => {
		await storePerformanceProfile(parsePerformanceProfile(FIXED_IP_STREAMING));

		const profiles = await connectSlots();

		expect(profiles).toHaveLength(5);
		for (const profile of profiles) {
			expect(profile).toEqual(wireProfile("speed", wireWindow(1, 1)));
		}
	});

	it("provisions auto when ur.io never handed any over", async () => {
		const profiles = await connectSlots();

		expect(profiles).toEqual([null, null, null, null, null]);
	});
});
