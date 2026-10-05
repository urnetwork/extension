// The connect options ur.io hands the extension must reach the auth-client
// call as the profile the native apps send, or a session provisioned without
// a ur.io tab (renewal, popup connect, device recreate) runs in Auto whatever
// the user chose.
import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { makeJwt, NETWORK_ID, OTHER_NETWORK_ID } from "./bridge/harness";
import { buildAuthParams } from "../src/utils/auth-params";
import {
	loadPerformanceProfile,
	parsePerformanceProfile,
	storePerformanceProfile,
} from "../src/utils/performance-profile";
import {
	AUTO,
	FIXED_IP_STREAMING,
	FIXED_IP_WEB,
	STREAMING,
	WEB,
	wireProfile,
	wireWindow,
} from "./performance-profiles";

describe("parsePerformanceProfile", () => {
	it("passes on the profiles ur.io builds, as the auth-client wire takes them", () => {
		const cases: Array<[unknown, unknown]> = [
			[AUTO, wireProfile("auto", null)],
			// Fixed IP is a window of exactly one exit in Web and Streaming
			[FIXED_IP_WEB, wireProfile("quality", wireWindow(1, 1))],
			[FIXED_IP_STREAMING, wireProfile("speed", wireWindow(1, 1))],
			[WEB, wireProfile("quality", wireWindow(2, 4))],
			[STREAMING, wireProfile("speed", wireWindow(2, 4))],
			// the orthogonal flags pass in every mode
			[
				{ ...AUTO, allowDirect: true, postQuantumEncryption: true },
				{ ...wireProfile("auto", null), allow_direct: true, post_quantum_encryption: true },
			],
			// null is the sdk's auto
			[null, null],
		];
		for (const [profile, wire] of cases) {
			expect(parsePerformanceProfile(profile), JSON.stringify(profile)).toEqual(wire);
		}
	});

	it("gives Auto no window size", () => {
		expect(parsePerformanceProfile({ ...AUTO, windowSize: { windowSizeMin: 1, windowSizeMax: 1 } })).toEqual(
			wireProfile("auto", null),
		);
	});

	it("keeps the window settings the sdk defaults at 0, and a quality window left to the sdk", () => {
		expect(
			parsePerformanceProfile({
				...WEB,
				windowSize: {
					windowSizeMin: 2,
					windowSizeMax: 4,
					windowSizeMinP2pOnly: 1,
					windowSizeHardMax: 6,
					windowSizeReconnectScale: 0.5,
					keepHealthiestCount: 2,
					ulimit: 3,
				},
			})?.window_size,
		).toEqual({
			window_size_min: 2,
			window_size_min_p2p_only: 1,
			window_size_max: 4,
			window_size_hard_max: 6,
			window_size_reconnect_scale: 0.5,
			keep_healthiest_count: 2,
			ulimit: 3,
		});
		expect(parsePerformanceProfile({ ...WEB, windowSize: null })).toEqual(wireProfile("quality", null));
	});

	it("refuses anything ur.io does not build, a window the multi client would refuse included", () => {
		const invalid: unknown[] = [
			undefined,
			"quality",
			[],
			{ ...FIXED_IP_WEB, windowType: "bogus" },
			{ ...FIXED_IP_WEB, windowType: undefined },
			{ ...FIXED_IP_WEB, allowDirect: "false" },
			{ ...FIXED_IP_WEB, postQuantumEncryption: undefined },
			{ ...FIXED_IP_WEB, windowSize: "1..1" },
			// max below min panics the multi client
			{ ...FIXED_IP_WEB, windowSize: { windowSizeMin: 4, windowSizeMax: 1 } },
			{ ...FIXED_IP_WEB, windowSize: { windowSizeMin: -1, windowSizeMax: 1 } },
			{ ...FIXED_IP_WEB, windowSize: { windowSizeMin: 1.5, windowSizeMax: 2 } },
			{ ...FIXED_IP_WEB, windowSize: { windowSizeMin: 1, windowSizeMax: 1, ulimit: "8" } },
			{ ...FIXED_IP_WEB, windowSize: { windowSizeMin: 1, windowSizeMax: 1, windowSizeReconnectScale: Number.NaN } },
			// an Auto window is dropped, never trusted
			{ ...AUTO, windowSize: { windowSizeMin: 4, windowSizeMax: 1 } },
		];
		for (const profile of invalid) {
			expect(() => parsePerformanceProfile(profile), JSON.stringify(profile)).toThrow(
				"Invalid performance profile",
			);
		}
	});
});

describe("buildAuthParams", () => {
	it("starts the hosted device with the connect options; none is auto", () => {
		expect(buildAuthParams().proxy_config?.initial_device_state?.performance_profile).toBeNull();
		const fixedIp = parsePerformanceProfile(FIXED_IP_WEB);
		expect(buildAuthParams(undefined, fixedIp).proxy_config?.initial_device_state).toMatchObject({
			location: { connect_location_id: { best_available: true } },
			performance_profile: wireProfile("quality", wireWindow(1, 1)),
		});
	});
});

describe("kept connect options", () => {
	let browser: ChromeMock;

	beforeEach(() => {
		browser = installChromeMock();
	});

	it("are the stored identity's network's, and never another network's", async () => {
		browser.seedStorage({ by_jwt: makeJwt({ network_id: NETWORK_ID }) });
		expect(await loadPerformanceProfile()).toBeNull();

		expect(await storePerformanceProfile(parsePerformanceProfile(FIXED_IP_WEB))).toBe(true);
		expect(await loadPerformanceProfile()).toEqual(wireProfile("quality", wireWindow(1, 1)));

		browser.seedStorage({ by_jwt: makeJwt({ network_id: OTHER_NETWORK_ID }) });
		expect(await loadPerformanceProfile()).toBeNull();
	});

	it("keep nothing without an identity", async () => {
		expect(await storePerformanceProfile(parsePerformanceProfile(FIXED_IP_WEB))).toBe(false);
		expect(await loadPerformanceProfile()).toBeNull();
	});
});
