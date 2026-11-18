// The extension's own sign-in (owner decision 2026-11-18,
// src/utils/own-sign-in.ts): ur.io used to hand the extension the page's own
// token (SETUP {jwt}, REFRESH_JWT after a payment), so the two shared one
// session, the account's Sessions list could not show or sign out the
// extension apart, and a sign-out on ur.io signed the extension out. Now the
// page hands over a one-use sign-in code, which the extension redeems for a
// session of its own, renews itself, and signs out on its own.
//
// Driven through the bridge's real wire contract (tests/bridge/harness.ts),
// with the real sdk client over a fake api (tests/bridge/fake-api.ts), so the
// requests the server sees are under test: their paths, bodies and bearers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBridgeHarness,
	NETWORK_ID,
	OTHER_NETWORK_ID,
	type BridgeHarness,
	type FakePort,
	type LiveSessionSeed,
} from "./harness";
import { DAY_S, networkToken, noAnswer, serveApi } from "./fake-api";
import { installChromeMock, SYSTEM_PROXY, type ChromeMock } from "../chrome-mock";

// Must match src/utils/own-sign-in.ts (pinned here: the alarm name and the
// storage key are durable state in the user's browser).
const OWN_ALARM = "urn-own-session-renew";
const OWN_SESSION_KEY = "own_session_id";

// synthetic session ids (no production identity)
const SESSION_OLD = "0a0a0a0a-0000-4000-8000-000000000001";
const SESSION_NEW = "0b0b0b0b-0000-4000-8000-000000000002";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const T0_S = Math.floor(Date.UTC(2026, 10, 1, 12) / 1000);

const OLD_TOKEN = networkToken(
	{ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1", session_id: SESSION_OLD },
	T0_S,
);
const NEW_TOKEN = networkToken({
	network_id: NETWORK_ID,
	network_name: "testnet",
	user_id: "user-1",
	session_id: SESSION_NEW,
});

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// the window networkTokenRenewalTime draws from: 40% to 50% of the lifetime
function renewalWindow(token: string): [number, number] {
	const { iat, exp } = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as {
		iat: number;
		exp: number;
	};
	const life = (exp - iat) * 1000;
	return [iat * 1000 + 0.4 * life, iat * 1000 + 0.5 * life];
}

function expectAlarmInWindow(chrome: ChromeMock, token: string) {
	const when = chrome.alarms.get(OWN_ALARM)?.when;
	const [from, to] = renewalWindow(token);
	expect(when).toBeGreaterThanOrEqual(from);
	expect(when).toBeLessThanOrEqual(to);
}

// the extension signed in with a session of its own, connected through its
// one hosted proxy client
async function ownSignedIn(h: BridgeHarness): Promise<LiveSessionSeed> {
	const seed = await h.seedLiveSession({ jwt: OLD_TOKEN });
	h.chrome.seedStorage({ [OWN_SESSION_KEY]: SESSION_OLD, selected_connect_location: "{}" });
	return seed;
}

// the extension's identity and its live session exactly as seeded: nothing
// torn down, nothing replaced
function expectUntouched(h: BridgeHarness, seed: LiveSessionSeed) {
	expect(h.chrome.getStored("by_jwt")).toBe(seed.jwt);
	expect(h.chrome.getStored(OWN_SESSION_KEY)).toBe(SESSION_OLD);
	expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
	expect(h.chrome.proxyValue()).toMatchObject({
		mode: "fixed_servers",
		rules: { singleProxy: { host: seed.proxyHostLabel } },
	});
	expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
}

const REDEEM = "POST /auth/code-login";
const RENEW = "POST /auth/network-refresh";
const REVOKE = "POST /network/revoke-session";

const revoked = () => ({ json: { operation_id: "op", status: "revoked", state: "enforced" } });

describe("the extension's own sign-in", () => {
	let h: BridgeHarness;
	let app: FakePort;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("PING says SETUP takes a sign-in code and RENEW_SESSION renews its own sign-in", async () => {
		const res = await app.request("PING");
		expect(res).toMatchObject({
			ok: true,
			data: { version: "0.0.0-test", setupAuthCode: true, renewSession: true },
		});
	});

	describe("SETUP with a sign-in code", () => {
		let seed: LiveSessionSeed;

		beforeEach(async () => {
			seed = await ownSignedIn(h);
		});

		it("redeems the code for a session of its own, then replaces the old sign-in", async () => {
			// what the extension held while the code was redeemed
			const heldAtRedeem: unknown[] = [];
			const api = serveApi({
				[REDEEM]: () => {
					heldAtRedeem.push(h.chrome.getStored("by_jwt"), h.chrome.getStored("bridge_session"));
					return { json: { by_jwt: NEW_TOKEN } };
				},
				[REVOKE]: revoked,
			});

			const res = await app.request("SETUP", {
				authCode: "synthetic-code-1",
				networkId: NETWORK_ID,
				networkName: "testnet",
			});

			expect(res).toMatchObject({
				ok: true,
				data: { user: { networkId: NETWORK_ID, networkName: "testnet", guestMode: false } },
			});
			// the answer carries no token: none crosses into the page
			expect(JSON.stringify(res)).not.toContain(NEW_TOKEN);

			// one redemption, on the public route, under a request id
			const [redeem] = api.callsTo(REDEEM);
			expect(api.callsTo(REDEEM)).toHaveLength(1);
			expect(redeem.body).toEqual({ auth_code: "synthetic-code-1", request_id: expect.stringMatching(UUID) });
			expect(redeem.authorization).toBeNull();
			// the extension's client info: the Sessions list names its session
			expect(JSON.parse(redeem.clientInfo ?? "{}")).toMatchObject({
				device_type: "web",
				distribution: "extension_chrome",
			});
			// redeemed while the old sign-in still stood
			expect(heldAtRedeem).toEqual([OLD_TOKEN, seed.record]);

			// its own sign-in now, marked as the extension's own session
			expect(h.chrome.getStored("by_jwt")).toBe(NEW_TOKEN);
			expect(h.chrome.getStored(OWN_SESSION_KEY)).toBe(SESSION_NEW);
			// the old identity torn down: proxy off, the client released with
			// the old token
			expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
			expect(h.chrome.getStored("bridge_session")).toBeUndefined();
			expect(h.api.removeNetworkClient).toHaveBeenCalledWith(seed.record.clientId, OLD_TOKEN);
			// and its own session signed out on the server, with its own token
			expect(api.callsTo(REVOKE)).toEqual([
				expect.objectContaining({
					authorization: `Bearer ${OLD_TOKEN}`,
					body: { session_id: SESSION_OLD, operation_id: expect.stringMatching(UUID) },
				}),
			]);
		});

		it("sends a redemption whose answer was lost once more, with the same code and request id", async () => {
			let calls = 0;
			const api = serveApi({
				[REDEEM]: () => (++calls === 1 ? noAnswer() : { json: { by_jwt: NEW_TOKEN } }),
				[REVOKE]: revoked,
			});

			const res = await app.request("SETUP", { authCode: "synthetic-code-1", networkId: NETWORK_ID });

			expect(res.ok).toBe(true);
			const [first, second] = api.callsTo(REDEEM);
			expect(api.callsTo(REDEEM)).toHaveLength(2);
			expect(second.body).toEqual(first.body);
			expect(h.chrome.getStored("by_jwt")).toBe(NEW_TOKEN);
		});

		it("sends it once more only: with no answer the old sign-in stays as it was", async () => {
			const api = serveApi({ [REDEEM]: noAnswer });

			const res = await app.request("SETUP", { authCode: "synthetic-code-1", networkId: NETWORK_ID });

			expect(res.ok).toBe(false);
			expect(api.callsTo(REDEEM)).toHaveLength(2);
			expectUntouched(h, seed);
			expect(api.callsTo(REVOKE)).toHaveLength(0);
		});

		it("a refused code answers auth_code_refused and leaves the old sign-in as it was", async () => {
			const api = serveApi({
				[REDEEM]: () => ({ json: { by_jwt: "", error: { message: "Invalid auth code." } } }),
			});

			const res = await app.request("SETUP", { authCode: "synthetic-used-code", networkId: NETWORK_ID });

			expect(res).toMatchObject({ ok: false, code: "auth_code_refused" });
			// a refusal is not resent
			expect(api.callsTo(REDEEM)).toHaveLength(1);
			expectUntouched(h, seed);
		});

		it("the session cap answers session_limit_reached and leaves the old sign-in as it was", async () => {
			const api = serveApi({
				[REDEEM]: () => ({
					status: 409,
					json: { code: "session_limit_reached", error: "Too many active sessions." },
				}),
			});

			const res = await app.request("SETUP", { authCode: "synthetic-code-1", networkId: NETWORK_ID });

			expect(res).toMatchObject({ ok: false, code: "session_limit_reached" });
			expect(api.callsTo(REDEEM)).toHaveLength(1);
			expectUntouched(h, seed);
		});

		it("another network's sign-in answers wrong_network, and the unused session is signed out", async () => {
			const otherToken = networkToken({ network_id: OTHER_NETWORK_ID, session_id: SESSION_NEW });
			const api = serveApi({
				[REDEEM]: () => ({ json: { by_jwt: otherToken } }),
				[REVOKE]: revoked,
			});

			const res = await app.request("SETUP", { authCode: "synthetic-code-1", networkId: NETWORK_ID });

			expect(res).toMatchObject({ ok: false, code: "wrong_network" });
			expectUntouched(h, seed);
			expect(api.callsTo(REVOKE)).toEqual([
				expect.objectContaining({
					authorization: `Bearer ${otherToken}`,
					body: { session_id: SESSION_NEW, operation_id: expect.stringMatching(UUID) },
				}),
			]);
		});

		it("a guest's sign-in is refused and the old sign-in stays", async () => {
			serveApi({
				[REDEEM]: () => ({ json: { by_jwt: networkToken({ network_id: NETWORK_ID, guest_mode: true }) } }),
			});

			const res = await app.request("SETUP", { authCode: "synthetic-code-1", networkId: NETWORK_ID });

			expect(res.ok).toBe(false);
			expect(res.error).toMatch(/guest/i);
			expectUntouched(h, seed);
		});

		it("an older page's SETUP {jwt} still adopts the page's token, which is not the extension's own", async () => {
			const api = serveApi({ [REVOKE]: revoked });
			const pageToken = networkToken({ network_id: NETWORK_ID, network_name: "testnet", session_id: SESSION_NEW });

			const res = await app.request("SETUP", { jwt: pageToken });

			expect(res.ok).toBe(true);
			expect(h.chrome.getStored("by_jwt")).toBe(pageToken);
			// the page's session: the extension's sign-out never revokes it
			expect(h.chrome.getStored(OWN_SESSION_KEY)).toBeUndefined();
			// the extension's own old session is over, and signed out
			expect(api.callsTo(REVOKE)).toEqual([
				expect.objectContaining({ body: expect.objectContaining({ session_id: SESSION_OLD }) }),
			]);
		});
	});

	describe("RENEW_SESSION", () => {
		it("renews the extension's own token with that token, in place", async () => {
			const seed = await ownSignedIn(h);
			const renewed = networkToken({ network_id: NETWORK_ID, network_name: "testnet", session_id: SESSION_OLD });
			const api = serveApi({ [RENEW]: () => ({ json: { by_jwt: renewed } }) });

			const res = await app.request("RENEW_SESSION");

			expect(res).toMatchObject({ ok: true, data: { status: "renewed" } });
			expect(api.callsTo(RENEW)).toEqual([expect.objectContaining({ authorization: `Bearer ${OLD_TOKEN}` })]);
			expect(h.chrome.getStored("by_jwt")).toBe(renewed);
			expect(h.chrome.getStored(OWN_SESSION_KEY)).toBe(SESSION_OLD);
			// nothing reconnects or is released
			expect(h.chrome.proxySettingsSetCalls).toHaveLength(0);
			expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
			// the next renewal is set for the new token
			expectAlarmInWindow(h.chrome, renewed);
		});

		it("answers no_session without a sign-in, and asks the server nothing", async () => {
			const api = serveApi({});

			const res = await app.request("RENEW_SESSION");

			expect(res).toMatchObject({ ok: true, data: { status: "no_session" } });
			expect(api.calls).toHaveLength(0);
		});

		it("a rejected renewal is the server ending the sign-in: the extension signs out", async () => {
			const seed = await ownSignedIn(h);
			const api = serveApi({ [RENEW]: () => ({ status: 401, json: { error: "session_revoked" } }) });

			const res = await app.request("RENEW_SESSION");

			expect(res).toMatchObject({ ok: true, data: { status: "signed_out" } });
			// signed out the way the popup's sign-out does
			for (const key of ["by_jwt", "network_name", OWN_SESSION_KEY, "selected_connect_location", "bridge_session"]) {
				expect(h.chrome.getStored(key), key).toBeUndefined();
			}
			expect(h.chrome.proxyValue()).toEqual(SYSTEM_PROXY);
			// the ended token releases nothing: the client waits for a later pass
			expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
			expect(JSON.stringify(h.chrome.getStored("pending_release_clients"))).toContain(String(seed.record.clientId));
			// the server ended the session: nothing to sign out there
			expect(api.callsTo(REVOKE)).toHaveLength(0);
			expect(h.chrome.alarms.has(OWN_ALARM)).toBe(false);
			// an open popup and the ur.io tabs hear of it
			expect(h.chrome.runtimeMessages).toContainEqual({ type: "SIGNED_OUT" });
			expect(app.events).toContainEqual(
				expect.objectContaining({ event: "USER_CHANGED", payload: { user: null } }),
			);
		});

		it("a renewal with no answer fails and keeps the token", async () => {
			await ownSignedIn(h);
			serveApi({ [RENEW]: noAnswer });

			const res = await app.request("RENEW_SESSION");

			expect(res.ok).toBe(false);
			expect(h.chrome.getStored("by_jwt")).toBe(OLD_TOKEN);
		});
	});

	describe("the renewal alarm", () => {
		const fire = () => {
			for (const listener of h.chrome.onAlarmListeners) {
				listener({ name: OWN_ALARM, scheduledTime: Date.now() });
			}
		};
		const changeToken = (newValue: string | undefined) => {
			for (const listener of h.chrome.onStorageChangedListeners) {
				listener({ by_jwt: { newValue } }, "local");
			}
		};

		it("a new token sets it between 40% and 50% of the token's lifetime; no token clears it", async () => {
			const token = networkToken({ network_id: NETWORK_ID, session_id: SESSION_NEW }, T0_S);
			changeToken(token);
			await settle();
			expectAlarmInWindow(h.chrome, token);
			// the window is days away, not now
			expect(h.chrome.alarms.get(OWN_ALARM)?.when).toBeGreaterThan((T0_S + 12 * DAY_S) * 1000 - 1);

			changeToken(undefined);
			await settle();
			expect(h.chrome.alarms.has(OWN_ALARM)).toBe(false);
		});

		it("renews, stores the new token and sets the next renewal", async () => {
			await ownSignedIn(h);
			const renewed = networkToken({ network_id: NETWORK_ID, session_id: SESSION_OLD });
			serveApi({ [RENEW]: () => ({ json: { by_jwt: renewed } }) });

			fire();

			await vi.waitFor(() => expect(h.chrome.getStored("by_jwt")).toBe(renewed));
			await settle();
			expectAlarmInWindow(h.chrome, renewed);
		});

		it("a renewal with no answer is tried again after 15 minutes", async () => {
			await ownSignedIn(h);
			const api = serveApi({ [RENEW]: noAnswer });
			const before = Date.now();

			fire();

			await vi.waitFor(() => expect(h.chrome.alarms.has(OWN_ALARM)).toBe(true));
			const when = h.chrome.alarms.get(OWN_ALARM)?.when ?? 0;
			expect(when - before).toBeGreaterThanOrEqual(15 * 60 * 1000);
			expect(when - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000);
			expect(api.callsTo(RENEW)).toHaveLength(1);
			expect(h.chrome.getStored("by_jwt")).toBe(OLD_TOKEN);
		});

		it("a rejected renewal signs the extension out", async () => {
			await ownSignedIn(h);
			serveApi({ [RENEW]: () => ({ status: 401, json: { error: "session_revoked" } }) });

			fire();

			await vi.waitFor(() => expect(h.chrome.getStored("by_jwt")).toBeUndefined());
			await settle();
			expect(h.chrome.getStored("bridge_session")).toBeUndefined();
			expect(h.chrome.alarms.has(OWN_ALARM)).toBe(false);
		});

		it("an answer about a token the extension no longer holds changes nothing", async () => {
			await ownSignedIn(h);
			const signedInAnew = networkToken({ network_id: NETWORK_ID, session_id: SESSION_NEW });
			let answer: { status?: number; json?: unknown } = {
				json: { by_jwt: networkToken({ network_id: NETWORK_ID, session_id: SESSION_OLD }) },
			};
			const api = serveApi({
				[RENEW]: () => {
					// the popup signs in anew while the renewal is out
					h.chrome.seedStorage({ by_jwt: signedInAnew });
					return answer;
				},
			});

			fire();
			await vi.waitFor(() => expect(api.callsTo(RENEW)).toHaveLength(1));
			await settle();
			expect(h.chrome.getStored("by_jwt")).toBe(signedInAnew);

			// nor does a rejection sign the new sign-in out
			h.chrome.seedStorage({ by_jwt: OLD_TOKEN });
			answer = { status: 401, json: { error: "session_revoked" } };
			fire();
			await vi.waitFor(() => expect(api.callsTo(RENEW)).toHaveLength(2));
			await settle();
			expect(h.chrome.getStored("by_jwt")).toBe(signedInAnew);
			expect(h.chrome.getStored("bridge_session")).toBeDefined();
		});
	});

	describe("the popup's sign-out", () => {
		it("signs the extension's own session out on the server with its token, after releasing its client", async () => {
			const seed = await ownSignedIn(h);
			const releasesAtRevoke: number[] = [];
			const api = serveApi({
				[REVOKE]: () => {
					releasesAtRevoke.push(h.api.removeNetworkClient.mock.calls.length);
					return revoked();
				},
			});

			const session = await h.bridge.endFromPopup();

			expect(session.connected).toBe(false);
			expect(h.api.removeNetworkClient).toHaveBeenCalledWith(seed.record.clientId, OLD_TOKEN);
			expect(api.callsTo(REVOKE)).toEqual([
				expect.objectContaining({
					authorization: `Bearer ${OLD_TOKEN}`,
					body: { session_id: SESSION_OLD, operation_id: expect.stringMatching(UUID) },
				}),
			]);
			expect(releasesAtRevoke).toEqual([1]);
			expect(h.chrome.getStored(OWN_SESSION_KEY)).toBeUndefined();
		});

		it("a server that does not answer holds the sign-out about 2 seconds, no longer", async () => {
			await ownSignedIn(h);
			const api = serveApi({ [REVOKE]: () => "hang" });
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

			let ended = false;
			const ending = h.bridge.endFromPopup().then(() => {
				ended = true;
			});
			// the clock stands still until the sign-out asks the server
			for (let i = 0; i < 50 && api.callsTo(REVOKE).length === 0; i++) await settle();
			expect(api.callsTo(REVOKE)).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(1_900);
			expect(ended).toBe(false);
			await vi.advanceTimersByTimeAsync(200);
			await ending;
			expect(ended).toBe(true);
		});

		it("never signs out a session a page handed over, nor a token without a session id", async () => {
			const api = serveApi({ [REVOKE]: revoked });
			// an older page's SETUP {jwt}: the page's own session
			await h.seedLiveSession({ jwt: networkToken({ network_id: NETWORK_ID, session_id: SESSION_OLD }) });
			await h.bridge.endFromPopup();
			// a token from before sessions were tagged
			await h.seedLiveSession({ jwt: networkToken({ network_id: NETWORK_ID }) });
			h.chrome.seedStorage({ [OWN_SESSION_KEY]: SESSION_OLD });
			await h.bridge.endFromPopup();

			expect(api.callsTo(REVOKE)).toHaveLength(0);
		});
	});

	describe("the popup's code sign-in (and SSO's)", () => {
		it("signs in with a session of its own and hands the popup its token", async () => {
			const api = serveApi({ [REDEEM]: () => ({ json: { by_jwt: NEW_TOKEN } }) });

			const answer = await h.bridge.signInWithCode("synthetic-code-1");

			expect(answer).toEqual({ success: true, jwt: NEW_TOKEN, networkName: "testnet" });
			expect(api.callsTo(REDEEM)[0].body).toEqual({
				auth_code: "synthetic-code-1",
				request_id: expect.stringMatching(UUID),
			});
			expect(h.chrome.getStored("by_jwt")).toBe(NEW_TOKEN);
			expect(h.chrome.getStored(OWN_SESSION_KEY)).toBe(SESSION_NEW);
			expect(h.chrome.runtimeMessages).toContainEqual(
				expect.objectContaining({ type: "JWT_RECEIVED", jwt: NEW_TOKEN }),
			);
		});

		it("answers the session cap's refusal and a refused code by their codes", async () => {
			let answer: { status?: number; json?: unknown } = {
				status: 409,
				json: { code: "session_limit_reached", error: "Too many active sessions." },
			};
			serveApi({ [REDEEM]: () => answer });
			expect(await h.bridge.signInWithCode("synthetic-code-1")).toMatchObject({
				success: false,
				code: "session_limit_reached",
			});

			answer = { json: { by_jwt: "", error: { message: "Invalid auth code." } } };
			expect(await h.bridge.signInWithCode("synthetic-code-2")).toMatchObject({
				success: false,
				code: "auth_code_refused",
			});
			expect(h.chrome.getStored("by_jwt")).toBeUndefined();
		});
	});
});

// The service worker starting with a sign-in stored: its renewal alarm.
describe("the renewal alarm at service worker start", () => {
	async function startWorker(seed: (mock: ChromeMock) => void): Promise<ChromeMock> {
		vi.resetModules();
		const mock = installChromeMock();
		seed(mock);
		vi.doMock("../../src/bridge/api", () => ({
			authNetworkClient: vi.fn(),
			removeNetworkClient: vi.fn(async () => true),
			activeProxyClientIds: vi.fn(async () => null),
			subscriptionBalance: vi.fn(async () => null),
		}));
		const bridge = await import("../../src/bridge/background");
		bridge.initBridge();
		await settle();
		return mock;
	}

	it("a stored sign-in without an alarm gets one in its renewal window", async () => {
		const mock = await startWorker((m) => m.seedStorage({ by_jwt: OLD_TOKEN }));
		expectAlarmInWindow(mock, OLD_TOKEN);
	});

	it("an alarm already set is kept: a worker that starts every minute never moves a retry", async () => {
		const retryAt = Date.now() + 15 * 60 * 1000;
		const mock = await startWorker((m) => {
			m.seedStorage({ by_jwt: OLD_TOKEN });
			m.alarms.set(OWN_ALARM, { when: retryAt });
		});
		expect(mock.alarmCreateCalls).toEqual([]);
		expect(mock.alarms.get(OWN_ALARM)).toEqual({ when: retryAt });
	});

	it("no sign-in, no alarm", async () => {
		const mock = await startWorker(() => {});
		expect(mock.alarmCreateCalls).toEqual([]);
	});
});
