// The bridge's proactive renewal alarm. It used to fire at exactly 80% of
// every session's lifetime, so browsers whose sessions started together
// re-provisioned through /network/auth-client together, every lifetime. Each
// session now renews at its own point in 70-80% of its lifetime, derived from
// its client id (src/utils/session-renewal.ts), and a short lifetime cannot
// renew in a loop. Driven through CONNECT and the alarm listener, with the
// clock under test control.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createBridgeHarness,
	makeJwt,
	NETWORK_ID,
	RENEW_ALARM,
	type BridgeHarness,
	type FakePort,
} from "./harness";
import { renewDelayMs, renewFraction } from "../../src/utils/session-renewal";

const T0 = Date.UTC(2026, 10, 1, 12);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// a synthetic client id, distinct for each i
function sessionClientId(i: number): string {
	return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

// a provisioned session for `clientId` expiring `lifetimeMs` from now
function provisioned(clientId: string, lifetimeMs: number) {
	return {
		by_client_jwt: makeJwt({ client_id: clientId }),
		proxy_config_result: {
			auth_token: `signed-${clientId}`,
			instance_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			proxy_host: "proxy.example.ur",
			https_proxy_port: 8443,
			api_base_url: "https://api.proxy.example.ur:8444",
			expiration_time: new Date(Date.now() + lifetimeMs).toISOString(),
		},
	};
}

describe("bridge session renewal", () => {
	let h: BridgeHarness;
	let app: FakePort;

	// a cold service worker with the extension set up for NETWORK_ID
	async function startWorker(): Promise<void> {
		h = await createBridgeHarness();
		app = h.connect();
		await app.request("SETUP", { jwt: makeJwt({ network_id: NETWORK_ID }) });
	}

	// CONNECT one session; the renewal alarm's delay from provisioning, or
	// null when none is scheduled
	async function connectSession(clientId: string, lifetimeMs: number): Promise<number | null> {
		h.api.authNetworkClient.mockImplementationOnce(async () => provisioned(clientId, lifetimeMs));
		h.chrome.alarms.delete(RENEW_ALARM);
		const res = await app.request("CONNECT");
		expect(res.ok).toBe(true);
		const alarm = h.chrome.alarms.get(RENEW_ALARM);
		return alarm?.when === undefined ? null : alarm.when - Date.now();
	}

	// SESSION_CHANGED events the renewal alarm has broadcast so far
	const renewals = () =>
		app.events.filter(
			(e) => e.event === "SESSION_CHANGED" && (e.payload as { reason?: string }).reason === "renew",
		).length;

	// Fire the renewal alarm each time it comes due until `end`, the way the
	// browser would, and return the times it fired. Stops early once it has
	// fired more than `limit` times (a loop the caller fails on).
	async function runRenewalsUntil(end: number, limit: number): Promise<number[]> {
		const fired: number[] = [];
		for (;;) {
			const when = h.chrome.alarms.get(RENEW_ALARM)?.when;
			if (when === undefined || end < when || limit < fired.length) {
				return fired;
			}
			vi.setSystemTime(when);
			h.chrome.alarms.delete(RENEW_ALARM);
			const before = renewals();
			for (const listener of h.chrome.onAlarmListeners) {
				listener({ name: RENEW_ALARM, scheduledTime: when });
			}
			await vi.waitFor(() => expect(renewals()).toBe(before + 1));
			fired.push(when);
		}
	}

	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
		await startWorker();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renews each session at its own point within 70-80% of its lifetime", async () => {
		for (let i = 0; i < 20; i++) {
			const clientId = sessionClientId(i);

			const delay = await connectSession(clientId, HOUR);

			expect(delay).not.toBeNull();
			expect(delay! / HOUR).toBeGreaterThanOrEqual(0.7);
			expect(delay! / HOUR).toBeLessThanOrEqual(0.8);
			expect(delay).toBe(Math.floor(HOUR * renewFraction(clientId)));
		}
	});

	it("a restart keeps the point", async () => {
		const clientId = sessionClientId(7);
		const before = await connectSession(clientId, HOUR);

		// a fresh service worker and browser: new modules, new state
		await startWorker();
		const after = await connectSession(clientId, HOUR);

		expect(after).toBe(before);
		expect(after).toBe(renewDelayMs(clientId, HOUR));
	});

	it("different sessions get different points", async () => {
		const fractions: number[] = [];
		for (let i = 0; i < 20; i++) {
			fractions.push((await connectSession(sessionClientId(i), HOUR))! / HOUR);
		}

		expect(new Set(fractions).size).toBe(fractions.length);
		expect(Math.max(...fractions) - Math.min(...fractions)).toBeGreaterThan(0.05);
	});

	it("nothing renews later than 80% of the lifetime", async () => {
		let next = 1_000;
		for (const lifetime of [75 * SECOND, 2 * MINUTE, HOUR, DAY, 30 * DAY, 400 * DAY]) {
			// the renewal provisions a session with the same lifetime
			h.api.authNetworkClient.mockImplementation(async () =>
				provisioned(sessionClientId(next++), lifetime),
			);
			for (let i = 0; i < 5; i++) {
				const start = Date.now();
				const delay = await connectSession(sessionClientId(i), lifetime);

				// the renewal has happened by the 80% point
				const fired = await runRenewalsUntil(start + lifetime * 0.8, 1);
				expect(delay).not.toBeNull();
				expect(fired).toEqual([start + delay!]);
			}
		}
	});

	it("short lifetimes do not renew in a loop", async () => {
		// every renewal provisions another session with the same short lifetime
		for (const lifetime of [SECOND, 30 * SECOND, 74 * SECOND, 76 * SECOND]) {
			await startWorker();
			let next = 0;
			h.api.authNetworkClient.mockImplementation(async () =>
				provisioned(sessionClientId(next++), lifetime),
			);
			const start = Date.now();
			await app.request("CONNECT");

			const fired = await runRenewalsUntil(start + 10 * MINUTE, 10);

			// at most one renewal a minute, each a minute after the last provision
			expect(fired.length).toBeLessThanOrEqual(10);
			let last = start;
			for (const at of fired) {
				expect(at - last).toBeGreaterThanOrEqual(MINUTE);
				last = at;
			}
			if (lifetime * 0.8 < MINUTE) {
				// too short to renew a minute out and still by 80%: no renewal
				expect(fired).toEqual([]);
				expect(h.api.authNetworkClient).toHaveBeenCalledTimes(1);
			}
		}
	});
});
