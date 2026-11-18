// An install from before the extension signed in with a session of its own
// holds ur.io's token (an older page's SETUP {jwt}, an older version's
// SET_JWT), so it shares ur.io's session, and ur.io's sign-out signs it out:
// the server ends the session, and the extension's next renewal of the shared
// token is rejected. Owner decision 2026-11-18, "Migrate automatically": at
// its next start the extension creates a sign-in code with the token it holds,
// redeems it for a session of its own, checks it as SETUP does, and only then
// switches over, leaving ur.io's session alone. A try that does not happen
// keeps the old token working and waits on a backoff, a few tries a day at
// most (src/bridge/background.ts migrateToOwnSignIn).
//
// Driven through the bridge's real module (tests/bridge/harness.ts), with the
// real sdk client over a fake api (tests/bridge/fake-api.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeHarness, makeJwt, NETWORK_ID, OTHER_NETWORK_ID, type BridgeHarness, type FakePort, type LiveSessionSeed } from "./harness";
import { networkToken, noAnswer, serveApi, type ApiCall, type ApiRoute } from "./fake-api";

// Must match src/utils/own-sign-in.ts (pinned here: durable state in the
// user's browser).
const OWN_SESSION_KEY = "own_session_id";
const MIGRATION_KEY = "own_sign_in_migration";
const MIGRATION_ALARM = "urn-own-sign-in-migrate";
const RENEW_ALARM = "urn-own-session-renew";

// synthetic session ids (no production identity)
const SESSION_URIO = "0c0c0c0c-0000-4000-8000-000000000003";
const SESSION_OWN = "0d0d0d0d-0000-4000-8000-000000000004";

const HOUR = 60 * 60 * 1000;

const URIO_TOKEN = networkToken({
	network_id: NETWORK_ID,
	network_name: "testnet",
	user_id: "user-1",
	session_id: SESSION_URIO,
});
const OWN_TOKEN = networkToken({
	network_id: NETWORK_ID,
	network_name: "testnet",
	user_id: "user-1",
	session_id: SESSION_OWN,
});

const CREATE = "POST /auth/code-create";
const REDEEM = "POST /auth/code-login";
const RENEW = "POST /auth/network-refresh";
const REVOKE = "POST /network/revoke-session";

const bearer = (token: string) => `Bearer ${token}`;

const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// the n-th client the server provisions
function provisioned(n: number) {
	return {
		by_client_jwt: makeJwt({ client_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}` }),
		proxy_config_result: {
			auth_token: `SIGNED${n}`,
			instance_id: `aaaaaaaa-bbbb-cccc-dddd-${n.toString(16).padStart(12, "0")}`,
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
		},
	};
}

// The server's side: ur.io's session until ur.io signs out, and the session
// the extension redeems. A code made with a live session's token redeems for
// OWN_TOKEN; a renewal renews a live session and rejects an ended one.
// the session a request's bearer carries
function bearerSession(call: ApiCall): string | null {
	const token = call.authorization?.replace(/^Bearer /, "") ?? "";
	try {
		const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			session_id?: unknown;
		};
		return typeof claims.session_id === "string" ? claims.session_id : null;
	} catch {
		return null;
	}
}

function server(options: { redeem?: ApiRoute } = {}) {
	const ended = new Set<string>();
	const live = (call: ApiCall) => {
		const sessionId = bearerSession(call);
		return sessionId !== null && !ended.has(sessionId);
	};
	let renewals = 0;
	const api = serveApi({
		[CREATE]: (call) => (live(call) ? { json: { auth_code: "code-1" } } : { status: 401, json: { error: "session_revoked" } }),
		[REDEEM]: options.redeem ?? (() => ({ json: { by_jwt: OWN_TOKEN } })),
		[RENEW]: (call) => {
			if (!live(call)) return { status: 401, json: { error: "session_revoked" } };
			// a renewal is the same session, freshly signed
			return {
				json: {
					by_jwt: networkToken({
						network_id: NETWORK_ID,
						network_name: "testnet",
						user_id: "user-1",
						session_id: bearerSession(call),
						jti: `renewal-${++renewals}`,
					}),
				},
			};
		},
		[REVOKE]: () => ({ json: { operation_id: "op", status: "revoked", state: "enforced" } }),
	});
	return {
		api,
		// ur.io signs out: the server ends ur.io's session
		urioSignsOut: () => ended.add(SESSION_URIO),
	};
}

// the renewal alarm fires
function renewNow(h: BridgeHarness) {
	for (const listener of h.chrome.onAlarmListeners) {
		listener({ name: RENEW_ALARM, scheduledTime: Date.now() });
	}
}

describe("an install that holds ur.io's token", () => {
	let h: BridgeHarness;
	let app: FakePort;
	let seed: LiveSessionSeed;

	beforeEach(async () => {
		h = await createBridgeHarness();
		app = h.connect();
		// connected through its one client, made with ur.io's token, and no
		// mark of a session of its own
		seed = await h.seedLiveSession({ jwt: URIO_TOKEN });
		let next = 1;
		h.api.authNetworkClient.mockImplementation(async () => provisioned(next++));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("without the migration, ur.io's sign-out signs it out (the shared session ends)", async () => {
		const { urioSignsOut } = server();
		urioSignsOut();

		renewNow(h);

		await vi.waitFor(() => expect(h.chrome.getStored("by_jwt")).toBeUndefined());
	});

	it("moves to a session of its own at its start, and then ur.io's sign-out leaves it signed in", async () => {
		const { api, urioSignsOut } = server();

		expect(await h.bridge.migrateToOwnSignIn()).toBe("migrated");
		await settle();

		// a code made with the token it held, redeemed for a sign-in of its own
		expect(api.callsTo(CREATE)).toHaveLength(1);
		expect(api.callsTo(CREATE)[0].authorization).toBe(bearer(URIO_TOKEN));
		expect(api.callsTo(CREATE)[0].body).toMatchObject({ uses: 1 });
		expect(api.callsTo(REDEEM)).toHaveLength(1);
		expect(api.callsTo(REDEEM)[0].body).toMatchObject({ auth_code: "code-1" });
		// ur.io's session is left alone
		expect(api.callsTo(REVOKE)).toEqual([]);

		expect(h.chrome.getStored("by_jwt")).toBe(OWN_TOKEN);
		expect(h.chrome.getStored(OWN_SESSION_KEY)).toBe(SESSION_OWN);
		expect(h.chrome.getStored(MIGRATION_KEY)).toBeUndefined();
		expect(h.chrome.alarms.has(MIGRATION_ALARM)).toBe(false);

		// the client made with ur.io's token carried ur.io's session: the
		// browser moved to one made with the extension's own, and the old one
		// went
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(h.api.authNetworkClient.mock.calls[0][1]).toBe(OWN_TOKEN);
		expect(h.chrome.proxyValue()).toMatchObject({
			mode: "fixed_servers",
			rules: { singleProxy: { host: "SIGNED1.proxy.example.ur" } },
		});
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(seed.record.clientId, OWN_TOKEN);
		expect(h.chrome.getStored("bridge_session")).toMatchObject({ signedProxyId: "SIGNED1" });
		expect(h.chrome.getStored("bridge_session")).not.toHaveProperty("replaceOnConnect");

		// ur.io signs out: the extension renews its own session and stays
		urioSignsOut();
		renewNow(h);
		await vi.waitFor(() => expect(api.callsTo(RENEW)).toHaveLength(1));
		await settle();
		expect(api.callsTo(RENEW)[0].authorization).toBe(bearer(OWN_TOKEN));
		expect(h.chrome.getStored("by_jwt")).not.toBe(OWN_TOKEN);
		expect(h.chrome.getStored("by_jwt")).toEqual(expect.any(String));
		expect(h.chrome.getStored(OWN_SESSION_KEY)).toBe(SESSION_OWN);
		expect(h.chrome.getStored("bridge_session")).toMatchObject({ signedProxyId: "SIGNED1" });

		// once: a later start asks nothing
		const calls = api.calls.length;
		expect(await h.bridge.migrateToOwnSignIn()).toBe("not_needed");
		expect(api.calls).toHaveLength(calls);
	});

	it("not connected, its client is given back, and the next connect makes one with its own sign-in", async () => {
		server();
		await app.request("DISCONNECT");

		expect(await h.bridge.migrateToOwnSignIn()).toBe("migrated");
		await settle();

		expect(h.api.authNetworkClient).not.toHaveBeenCalled();
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(seed.record.clientId, OWN_TOKEN);
		expect(h.chrome.getStored("bridge_session")).toBeUndefined();

		const res = await app.request("CONNECT", {});
		expect(res.ok).toBe(true);
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
		expect(h.api.authNetworkClient.mock.calls[0][1]).toBe(OWN_TOKEN);
	});

	it("a replacement the plan's cap refuses keeps the browser on its client, and the next connect replaces it", async () => {
		server();
		h.api.authNetworkClient.mockImplementationOnce(async () => ({
			proxy_config_result: null,
			error: { message: "client limit", client_limit_exceeded: true },
		}));

		expect(await h.bridge.migrateToOwnSignIn()).toBe("migrated");
		await settle();

		// nothing given back, the browser where it was
		expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
		expect(h.chrome.proxyValue()).toMatchObject({ rules: { singleProxy: { host: seed.proxyHostLabel } } });
		expect(h.chrome.getStored("bridge_session")).toMatchObject({
			signedProxyId: seed.record.signedProxyId,
			replaceOnConnect: true,
		});

		// the next connect at the same location makes a new client
		const res = await app.request("CONNECT", {});
		expect(res.ok).toBe(true);
		expect(h.api.authNetworkClient).toHaveBeenCalledTimes(2);
		expect(h.chrome.getStored("bridge_session")).toMatchObject({ signedProxyId: "SIGNED1" });
		expect(h.api.removeNetworkClient).toHaveBeenCalledWith(seed.record.clientId, OWN_TOKEN);
	});

	describe("a try that does not happen leaves the old sign-in working", () => {
		const failures: Array<[string, () => { redeem: ApiRoute }]> = [
			["the session cap", () => ({ redeem: () => ({ status: 409, json: { error: "too many sessions", code: "session_limit_reached" } }) })],
			["no answer", () => ({ redeem: noAnswer })],
			["a refused code", () => ({ redeem: () => ({ json: { error: { message: "expired" } } }) })],
		];
		for (const [name, options] of failures) {
			it(name, async () => {
				const { api } = server(options());

				expect(await h.bridge.migrateToOwnSignIn()).toBe("failed");
				await settle();

				expect(h.chrome.getStored("by_jwt")).toBe(URIO_TOKEN);
				expect(h.chrome.getStored(OWN_SESSION_KEY)).toBeUndefined();
				expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
				expect(h.chrome.proxyValue()).toMatchObject({ rules: { singleProxy: { host: seed.proxyHostLabel } } });
				expect(h.api.authNetworkClient).not.toHaveBeenCalled();
				expect(h.api.removeNetworkClient).not.toHaveBeenCalled();
				expect(api.callsTo(REVOKE)).toEqual([]);

				// it works on: it renews with the token it holds
				const renewal = await app.request("RENEW_SESSION");
				expect(renewal).toMatchObject({ ok: true, data: { status: "renewed" } });
				expect(api.callsTo(RENEW)[0].authorization).toBe(bearer(URIO_TOKEN));
			});
		}

		it("a token that ended", async () => {
			const { api, urioSignsOut } = server();
			urioSignsOut();

			expect(await h.bridge.migrateToOwnSignIn()).toBe("failed");
			expect(api.callsTo(REDEEM)).toEqual([]);
			expect(h.chrome.getStored("by_jwt")).toBe(URIO_TOKEN);
			expect(h.chrome.getStored("bridge_session")).toEqual(seed.record);
		});

		it("another network's sign-in is refused, and signed out unused", async () => {
			const otherNetwork = networkToken({ network_id: OTHER_NETWORK_ID, session_id: SESSION_OWN });
			const { api } = server({ redeem: () => ({ json: { by_jwt: otherNetwork } }) });

			expect(await h.bridge.migrateToOwnSignIn()).toBe("failed");
			expect(h.chrome.getStored("by_jwt")).toBe(URIO_TOKEN);
			expect(api.callsTo(REVOKE)).toHaveLength(1);
			expect(api.callsTo(REVOKE)[0].authorization).toBe(bearer(otherNetwork));
			expect(api.callsTo(REVOKE)[0].body).toMatchObject({ session_id: SESSION_OWN });
		});
	});

	it("tries again on a backoff, a few times a day at most, however often the worker starts", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const t0 = Date.UTC(2026, 10, 18, 0, 0);
		vi.setSystemTime(t0);
		const { api } = server({ redeem: noAnswer });
		const tries = () => api.callsTo(CREATE).length;

		// every minute of a day: a worker start, and the alarm when it is due
		for (let minute = 0; minute < 24 * 60; minute++) {
			vi.setSystemTime(t0 + minute * 60 * 1000);
			await h.bridge.migrateToOwnSignIn();
			const alarm = h.chrome.alarms.get(MIGRATION_ALARM);
			expect(alarm?.when).toBeGreaterThan(Date.now());
		}
		// tries at 0, 2 h, 10 h and 18 h
		expect(tries()).toBe(4);
		expect(h.chrome.getStored(MIGRATION_KEY)).toEqual({ failures: 4, nextAttemptAt: t0 + 26 * HOUR });
		expect(h.chrome.getStored("by_jwt")).toBe(URIO_TOKEN);
	});

	it("a sign-in of its own needs no migration, nor does no sign-in", async () => {
		const { api } = server();
		h.chrome.seedStorage({ by_jwt: OWN_TOKEN, [OWN_SESSION_KEY]: SESSION_OWN });
		expect(await h.bridge.migrateToOwnSignIn()).toBe("not_needed");

		h.chrome.seedStorage({ by_jwt: undefined });
		expect(await h.bridge.migrateToOwnSignIn()).toBe("not_needed");
		expect(api.calls).toEqual([]);
	});

	it("the popup signing in anew while the code is redeemed keeps the new sign-in, and the unused one is signed out", async () => {
		const popupToken = networkToken({ network_id: NETWORK_ID, session_id: "0e0e0e0e-0000-4000-8000-000000000005" });
		const { api } = server({
			redeem: () => {
				h.chrome.seedStorage({ by_jwt: popupToken });
				return { json: { by_jwt: OWN_TOKEN } };
			},
		});

		expect(await h.bridge.migrateToOwnSignIn()).toBe("not_needed");
		expect(h.chrome.getStored("by_jwt")).toBe(popupToken);
		expect(api.callsTo(REVOKE)).toHaveLength(1);
		expect(api.callsTo(REVOKE)[0].authorization).toBe(bearer(OWN_TOKEN));
	});
});
