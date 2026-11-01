// The popup's multi-IP pool renews itself ahead of expiry. It used to renew at
// exactly 80% of the first slot's lifetime, in lockstep with every other
// browser whose pool started at the same moment; it now renews at the pool's
// own point in 70-80% (src/utils/session-renewal.ts). A short lifetime, or one
// past setTimeout's range (which fires at once), must not renew in a loop.
// Driven through connect() with every timer and the clock under test control.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { makeJwt, NETWORK_ID } from "./bridge/harness";
import { ConnectionManager } from "../src/utils/connection-manager";
import { renewDelayMs } from "../src/utils/session-renewal";

type AuthNetworkClient = ConstructorParameters<typeof ConnectionManager>[0];

const T0 = Date.UTC(2026, 10, 1, 12);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// slots are provisioned 200 ms apart, five to a pool
const POOL_SIZE = 5;
const POOL_PROVISION_MS = 4 * 200;

// a synthetic client id, distinct for each i
function sessionClientId(i: number): string {
	return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

describe("popup pool renewal", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const browser = installChromeMock();
		browser.seedStorage({ by_jwt: makeJwt({ network_id: NETWORK_ID }) });
		// the background applies the pool's PAC script
		(browser.chrome.runtime as { sendMessage: unknown }).sendMessage = async () => ({
			success: true,
		});
		// health pings succeed, so no reconnect provisions in between
		vi.stubGlobal("fetch", async () => ({ ok: true }));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// A connected pool whose every provision is a new session expiring
	// `lifetimeMs` after it; `firstClientId` numbers the client ids. Returns
	// the auth-client mock and the slot-0 client id and lifetime the renewal
	// was scheduled from.
	async function connectPool(lifetimeMs: number, firstClientId = 0) {
		let next = firstClientId;
		const authNetworkClient = vi.fn<AuthNetworkClient>(async () => {
			const n = next++;
			return {
				by_client_jwt: makeJwt({ client_id: sessionClientId(n) }),
				proxy_config_result: {
					auth_token: `signed-${n}`,
					proxy_host: "proxy.example.ur",
					https_proxy_port: 8443,
					expiration_time: new Date(Date.now() + lifetimeMs).toISOString(),
					keepalive_seconds: 60,
				},
				error: null,
			};
		});
		const manager = new ConnectionManager(authNetworkClient, async () => ({}), {
			onStatusChange: () => {},
			onProxyChange: () => {},
			onError: () => {},
		});
		const connected = manager.connect();
		await vi.advanceTimersByTimeAsync(POOL_PROVISION_MS);
		await connected;
		expect(manager.getStatus()).toBe("connected");
		expect(authNetworkClient).toHaveBeenCalledTimes(POOL_SIZE);
		return {
			manager,
			authNetworkClient,
			clientId: sessionClientId(firstClientId),
			// slot 0 was provisioned at the start, the renewal scheduled at the end
			lifetime: lifetimeMs - POOL_PROVISION_MS,
		};
	}

	it("renews each pool at its own point within 70-80% of its lifetime", async () => {
		const points: number[] = [];
		for (let i = 0; i < 5; i++) {
			const pool = await connectPool(10 * MINUTE, 100 * i);
			const point = renewDelayMs(pool.clientId, pool.lifetime)!;

			// nothing before its point, then the renewal starts exactly at it
			await vi.advanceTimersByTimeAsync(point - 1);
			expect(pool.authNetworkClient).toHaveBeenCalledTimes(POOL_SIZE);
			await vi.advanceTimersByTimeAsync(1);
			expect(pool.authNetworkClient).toHaveBeenCalledTimes(POOL_SIZE + 1);

			expect(point / pool.lifetime).toBeGreaterThanOrEqual(0.7);
			expect(point / pool.lifetime).toBeLessThanOrEqual(0.8);
			points.push(point);
			pool.manager.destroy();
			await vi.runOnlyPendingTimersAsync();
		}
		// different pools, different points
		expect(new Set(points).size).toBe(points.length);
	});

	it("nothing renews later than 80% of the lifetime", async () => {
		for (const lifetime of [2 * MINUTE, 10 * MINUTE, HOUR, DAY]) {
			for (let i = 0; i < 5; i++) {
				const pool = await connectPool(lifetime, 100 * i);

				await vi.advanceTimersByTimeAsync(Math.floor(pool.lifetime * 0.8));

				expect(pool.authNetworkClient.mock.calls.length).toBeGreaterThan(POOL_SIZE);
				pool.manager.destroy();
				await vi.runOnlyPendingTimersAsync();
			}
		}
	});

	it("short lifetimes do not renew in a loop", async () => {
		for (const lifetime of [SECOND, 30 * SECOND, 70 * SECOND]) {
			const pool = await connectPool(lifetime);

			await vi.advanceTimersByTimeAsync(10 * MINUTE);

			// too short to renew a minute out and still by 80%: no renewal
			expect(pool.authNetworkClient).toHaveBeenCalledTimes(POOL_SIZE);
			pool.manager.destroy();
		}
	});

	it("a lifetime past setTimeout's range does not renew in a loop", async () => {
		const pool = await connectPool(60 * DAY);

		// before, the renewal fired at once and every pool after it did too
		await vi.advanceTimersByTimeAsync(MINUTE);

		expect(pool.authNetworkClient).toHaveBeenCalledTimes(POOL_SIZE);
		pool.manager.destroy();
	});
});
