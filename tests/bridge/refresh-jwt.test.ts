// REFRESH_JWT — the in-place jwt swap added for the post-payment entitlement
// re-push (see APP.md in mmm/ur.io). Contract under test:
//
//   refreshed     — same-network jwt replaces by_jwt in storage, nothing else
//                   moves (the zero-disruption property: the live proxy
//                   session, its renewal alarm, and the bridge session record
//                   are all untouched, and no api call is made)
//   no_session    — no stored identity, nothing swapped
//   wrong_network — different network_id, nothing swapped (page falls back to
//                   SETUP, whose teardown-and-replace behavior is pinned here
//                   as the contrast so a refactor cannot silently merge them)
//
// Malformed and guest jwts are rejected as errors (thrown, not statuses).
import { beforeEach, describe, expect, it } from "vitest";
import {
	createBridgeHarness,
	makeJwt,
	NETWORK_ID,
	OTHER_NETWORK_ID,
	RENEW_ALARM,
	type BridgeHarness,
	type FakePort,
	type LiveSessionSeed,
} from "./harness";

describe("REFRESH_JWT", () => {
	let h: BridgeHarness;
	let app: FakePort;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
	});

	describe("with a live session (seeded)", () => {
		let seed: LiveSessionSeed;

		beforeEach(async () => {
			seed = await h.seedLiveSession();
		});

		it("swaps the stored jwt in place and responds refreshed", async () => {
			const newJwt = makeJwt({
				network_id: NETWORK_ID,
				network_name: "testnet",
				// the whole point of the verb: a fresh claim set post-payment
				entitlement: "supporter",
			});

			const res = await app.request("REFRESH_JWT", { byJwt: newJwt });

			expect(res.ok).toBe(true);
			expect(res.data).toMatchObject({
				status: "refreshed",
				user: { networkId: NETWORK_ID, networkName: "testnet", guestMode: false },
			});
			expect(h.chrome.getStored("by_jwt")).toBe(newJwt);
			// popup kept in sync over the same signal SETUP sends
			expect(h.chrome.runtimeMessages).toContainEqual(
				expect.objectContaining({ type: "JWT_RECEIVED", jwt: newJwt }),
			);
		});

		it("leaves the live session state untouched (zero-disruption)", async () => {
			const newJwt = makeJwt({ network_id: NETWORK_ID, network_name: "testnet" });

			const res = await app.request("REFRESH_JWT", { byJwt: newJwt });
			expect(res.ok).toBe(true);

			// proxy: never reconfigured, still the seeded fixed-server session
			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
			expect(h.chrome.proxyValue()).toMatchObject({
				mode: "fixed_servers",
				rules: { singleProxy: { host: seed.proxyHostLabel } },
			});
			// renewal alarm: neither cleared nor rescheduled
			expect(h.chrome.alarmClearCalls).toHaveLength(0);
			expect(h.chrome.alarms.has(RENEW_ALARM)).toBe(true);
			// durable session record: byte-for-byte what was seeded
			expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
			expect(h.chrome.getStored("proxy_client_id")).toBe(seed.record.clientId);
			// no provisioning, no client release, no network at all
			expect(h.api.authNetworkClient).not.toHaveBeenCalled();
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
		});

		it("responds wrong_network for a different network's jwt and swaps nothing", async () => {
			const foreignJwt = makeJwt({ network_id: OTHER_NETWORK_ID });

			const res = await app.request("REFRESH_JWT", { byJwt: foreignJwt });

			expect(res.ok).toBe(true);
			expect(res.data).toMatchObject({ status: "wrong_network" });
			expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
			expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
		});

		it("responds wrong_network when the jwt carries no network_id", async () => {
			const res = await app.request("REFRESH_JWT", {
				byJwt: makeJwt({ user_id: "user-1" }),
			});
			expect(res.ok).toBe(true);
			expect(res.data).toMatchObject({ status: "wrong_network" });
			expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
		});

		it("rejects a malformed jwt without touching the stored one", async () => {
			const res = await app.request("REFRESH_JWT", { byJwt: "not-a-jwt" });
			expect(res.ok).toBe(false);
			expect(res.error).toBe("Invalid token");
			expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
		});

		it("rejects a guest jwt even for the same network", async () => {
			const guestJwt = makeJwt({ network_id: NETWORK_ID, guest_mode: true });
			const res = await app.request("REFRESH_JWT", { byJwt: guestJwt });
			expect(res.ok).toBe(false);
			expect(res.error).toMatch(/guest/i);
			expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
		});

		it("requires the byJwt payload key (jwt is SETUP's key, not this verb's)", async () => {
			const sameNetworkJwt = makeJwt({ network_id: NETWORK_ID });
			for (const payload of [
				undefined,
				{},
				{ jwt: sameNetworkJwt },
				{ byJwt: 42 },
				{ byJwt: "" },
			] as const) {
				const res = await app.request(
					"REFRESH_JWT",
					payload as Record<string, unknown> | undefined,
				);
				expect(res.ok).toBe(false);
				expect(res.error).toBe("Missing byJwt");
			}
			expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
		});
	});

	it("responds no_session when the extension holds no identity", async () => {
		const res = await app.request("REFRESH_JWT", {
			byJwt: makeJwt({ network_id: NETWORK_ID }),
		});
		expect(res.ok).toBe(true);
		expect(res.data).toEqual({ status: "no_session" });
		expect(h.chrome.getStored("by_jwt")).toBeUndefined();
	});
});

// The contrast pin: SETUP is the atomic teardown-and-replace path, REFRESH_JWT
// is the leave-everything-running path. If a refactor merges them, one of
// these two suites fails.
describe("SETUP vs REFRESH_JWT contrast", () => {
	let h: BridgeHarness;
	let app: FakePort;
	let seed: LiveSessionSeed;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
		seed = await h.seedLiveSession();
	});

	it("SETUP tears down the live session under the old identity and replaces it", async () => {
		const newJwt = makeJwt({
			network_id: OTHER_NETWORK_ID,
			network_name: "othernet",
		});

		const res = await app.request("SETUP", { jwt: newJwt });

		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({
			user: { networkId: OTHER_NETWORK_ID, networkName: "othernet" },
		});

		// identity replaced
		expect(h.chrome.getStored("by_jwt")).toBe(newJwt);
		// proxy torn down to direct
		expect(h.chrome.proxySettingsSetCalls.length).toBeGreaterThan(0);
		expect(h.chrome.proxyValue()).toEqual({ mode: "direct" });
		// durable session state and renewal alarm gone
		expect(h.chrome.getStored("bridge_session")).toBeUndefined();
		expect(h.chrome.getStored("proxy_client_id")).toBeUndefined();
		expect(h.chrome.alarmClearCalls).toContain(RENEW_ALARM);
		expect(h.chrome.alarms.has(RENEW_ALARM)).toBe(false);
		// the old network client is released under the OLD jwt
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(
			seed.record.clientId,
			seed.jwt,
		);
		// attached app tabs are told the session ended because of setup
		expect(app.events).toContainEqual(
			expect.objectContaining({
				dir: "event",
				event: "SESSION_CHANGED",
				payload: expect.objectContaining({
					reason: "setup",
					session: expect.objectContaining({ connected: false }),
				}),
			}),
		);
	});

	it("REFRESH_JWT performs none of SETUP's teardown", async () => {
		const newJwt = makeJwt({ network_id: NETWORK_ID, network_name: "testnet" });

		const res = await app.request("REFRESH_JWT", { byJwt: newJwt });

		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({ status: "refreshed" });
		expect(h.chrome.getStored("by_jwt")).toBe(newJwt);
		// everything SETUP dismantles is still standing
		expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
		expect(h.chrome.proxyValue()).toMatchObject({ mode: "fixed_servers" });
		expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
		expect(h.chrome.alarms.has(RENEW_ALARM)).toBe(true);
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
		// and no SESSION_CHANGED is broadcast — nothing about the session changed
		expect(app.events.filter((e) => e.event === "SESSION_CHANGED")).toHaveLength(0);
	});
});
