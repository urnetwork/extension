// REFRESH_JWT — an older ur.io page's push of its fresh token after a payment
// or an upgrade (APP.md in mmm/ur.io, extensionStore repushExtensionJwt). The
// extension used to swap the pushed token in, which made the page's session
// its own too: a sign-out on ur.io signed the extension out, and the account's
// Sessions list could not tell the two apart. Since it signs in with a session
// of its own (owner decision 2026-11-18), it never adopts a page's token: it
// renews its own, which carries the same new claims (a payment's Pro), and
// answers refreshed so the older page does not fall back to SETUP {jwt}.
// Contract under test:
//
//   refreshed     — the extension's own token renewed with its own bearer,
//                   nothing else moves (the zero-disruption property: the
//                   live proxy session, the bridge session record and the old
//                   version's alarm are untouched, and nothing is provisioned
//                   or released); also when the renewal gets no answer, which
//                   leaves the token for its alarm to renew
//   no_session    — no stored identity, nothing renewed; or the renewal was
//                   rejected (the sign-in ended) and the extension signed out
//   wrong_network — different network_id, nothing renewed (the page falls
//                   back to SETUP, whose teardown-and-replace behavior is
//                   pinned here as the contrast)
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
import { noAnswer, serveApi, type FakeApi } from "./fake-api";
import { SYSTEM_PROXY } from "../chrome-mock";

const RENEW = "POST /auth/network-refresh";

// the token the page pushes: the page's own sign-in, after a payment
const PAGE_JWT = makeJwt({
	network_id: NETWORK_ID,
	network_name: "testnet",
	session_id: "0c0c0c0c-0000-4000-8000-000000000003",
	entitlement: "supporter",
});

// the extension's own token, renewed by the server: its session, the new claims
const RENEWED_JWT = makeJwt({
	network_id: NETWORK_ID,
	network_name: "testnet",
	user_id: "user-1",
	entitlement: "supporter",
	renewed: true,
});

describe("REFRESH_JWT", () => {
	let h: BridgeHarness;
	let app: FakePort;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
	});

	describe("with a live session (seeded)", () => {
		let seed: LiveSessionSeed;
		let api: FakeApi;

		beforeEach(async () => {
			seed = await h.seedLiveSession();
			api = serveApi({ [RENEW]: () => ({ json: { by_jwt: RENEWED_JWT } }) });
		});

		it("renews its own token instead of adopting the page's, and responds refreshed", async () => {
			const res = await app.request("REFRESH_JWT", { byJwt: PAGE_JWT });

			expect(res.ok).toBe(true);
			expect(res.data).toMatchObject({
				status: "refreshed",
				user: { networkId: NETWORK_ID, networkName: "testnet", guestMode: false },
			});
			// renewed with the extension's own bearer; the page's token is never sent
			expect(api.callsTo(RENEW)).toEqual([expect.objectContaining({ authorization: `Bearer ${seed.jwt}` })]);
			expect(JSON.stringify(api.calls)).not.toContain(PAGE_JWT);
			// stored: the renewed token of its own session, never the page's
			expect(h.chrome.getStored("by_jwt")).toBe(RENEWED_JWT);
			expect(JSON.stringify([...h.chrome.storageData.values()])).not.toContain(PAGE_JWT);
			// popup kept in sync over the same signal SETUP sends
			expect(h.chrome.runtimeMessages).toContainEqual(
				expect.objectContaining({ type: "JWT_RECEIVED", jwt: RENEWED_JWT }),
			);
		});

		it("leaves the live session state untouched (zero-disruption)", async () => {
			const res = await app.request("REFRESH_JWT", { byJwt: PAGE_JWT });
			expect(res.ok).toBe(true);

			// proxy: never reconfigured, still the seeded fixed-server session
			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
			expect(h.chrome.proxyValue()).toMatchObject({
				mode: "fixed_servers",
				rules: { singleProxy: { host: seed.proxyHostLabel } },
			});
			// the old version's alarm: neither cleared nor rescheduled
			expect(h.chrome.alarmClearCalls).toHaveLength(0);
			expect(h.chrome.alarms.has(RENEW_ALARM)).toBe(true);
			// durable session record: byte-for-byte what was seeded
			expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
			expect(h.chrome.getStored("proxy_client_id")).toBe(seed.record.clientId);
			// no provisioning, no client release
			expect(h.api.authNetworkClient).not.toHaveBeenCalled();
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
		});

		it("responds refreshed when the renewal gets no answer, and keeps its token", async () => {
			api = serveApi({ [RENEW]: noAnswer });

			const res = await app.request("REFRESH_JWT", { byJwt: PAGE_JWT });

			// not an error: the older page would fall back to SETUP {jwt}
			expect(res).toMatchObject({ ok: true, data: { status: "refreshed" } });
			expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
		});

		it("a rejected renewal signs the extension out and responds no_session", async () => {
			api = serveApi({ [RENEW]: () => ({ status: 401, json: { error: "session_revoked" } }) });

			const res = await app.request("REFRESH_JWT", { byJwt: PAGE_JWT });

			expect(res).toMatchObject({ ok: true, data: { status: "no_session" } });
			expect(h.chrome.getStored("by_jwt")).toBeUndefined();
			expect(h.chrome.getStored("bridge_session")).toBeUndefined();
			expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
		});

		it("responds wrong_network for a different network's jwt and renews nothing", async () => {
			const foreignJwt = makeJwt({ network_id: OTHER_NETWORK_ID });

			const res = await app.request("REFRESH_JWT", { byJwt: foreignJwt });

			expect(res.ok).toBe(true);
			expect(res.data).toMatchObject({ status: "wrong_network" });
			expect(api.calls).toHaveLength(0);
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
			expect(api.calls).toHaveLength(0);
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
		const api = serveApi({});
		const res = await app.request("REFRESH_JWT", {
			byJwt: makeJwt({ network_id: NETWORK_ID }),
		});
		expect(res.ok).toBe(true);
		expect(res.data).toEqual({ status: "no_session" });
		expect(api.calls).toHaveLength(0);
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
		// proxy torn down: the setting released, the browser's own back
		expect(h.chrome.proxySettingsClearCalls.length).toBeGreaterThan(0);
		expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
		// durable session state and the old version's alarm gone
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
		serveApi({ [RENEW]: () => ({ json: { by_jwt: RENEWED_JWT } }) });

		const res = await app.request("REFRESH_JWT", { byJwt: PAGE_JWT });

		expect(res.ok).toBe(true);
		expect(res.data).toMatchObject({ status: "refreshed" });
		expect(h.chrome.getStored("by_jwt")).toBe(RENEWED_JWT);
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
