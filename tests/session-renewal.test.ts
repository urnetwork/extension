// The renewal point of a proxy session (src/utils/session-renewal.ts). Before
// it every session renewed at exactly 80% of its lifetime, so browsers whose
// sessions started together re-provisioned through /network/auth-client
// together. These pin the point's properties over many sessions; the bridge
// and popup tests check both surfaces schedule with it.
import { describe, expect, it, vi } from "vitest";
import {
	RENEW_MIN_DELAY_MS,
	renewDelayMs,
	renewFraction,
} from "../src/utils/session-renewal";

// sequential client ids: neighbours differ in their last characters only,
// the hardest case for spreading
function sessionClientId(i: number): string {
	return `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
}

// the first `count` of them
function sessionClientIds(count: number): string[] {
	return Array.from({ length: count }, (_, i) => sessionClientId(i));
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("session renewal point", () => {
	it("stays within 70-80% of the lifetime", () => {
		const outside = sessionClientIds(10_000)
			.map(renewFraction)
			.filter((f) => !(0.7 <= f && f <= 0.8));

		expect(outside).toEqual([]);
	});

	it("a restart keeps the point", async () => {
		const ids = sessionClientIds(100);
		const before = ids.map(renewFraction);

		// a fresh module, as after a browser or service worker restart
		vi.resetModules();
		const restarted = await import("../src/utils/session-renewal");

		expect(ids.map(restarted.renewFraction)).toEqual(before);
		expect(ids.map((id) => restarted.renewDelayMs(id, HOUR))).toEqual(
			ids.map((id) => renewDelayMs(id, HOUR)),
		);
	});

	it("different sessions get different points across the whole range", () => {
		const fractions = sessionClientIds(10_000).map(renewFraction);

		expect(new Set(fractions).size).toBe(fractions.length);
		// ten 1%-of-lifetime bands, 1,000 sessions each when evenly spread
		const bands = Array.from({ length: 10 }, () => 0);
		for (const f of fractions) {
			bands[Math.min(9, Math.floor((f - 0.7) * 100))]++;
		}
		for (const count of bands) {
			expect(count).toBeGreaterThan(900);
			expect(count).toBeLessThan(1_100);
		}
	});

	it("never renews later than 80% of the lifetime", () => {
		const lifetimes = [
			75 * SECOND,
			76 * SECOND,
			85 * SECOND,
			2 * MINUTE,
			HOUR + 1,
			DAY,
			30 * DAY,
			400 * DAY,
		];
		for (const lifetime of lifetimes) {
			for (const id of sessionClientIds(200)) {
				const delay = renewDelayMs(id, lifetime);
				expect(delay).not.toBeNull();
				expect(delay!).toBeLessThanOrEqual(lifetime * 0.8);
				expect(delay!).toBeGreaterThanOrEqual(Math.floor(lifetime * 0.7));
			}
		}
	});

	it("short lifetimes do not renew in a loop", () => {
		const ids = sessionClientIds(200);
		// too short to renew at least a minute out and still by 80%: no renewal
		for (const lifetime of [1, SECOND, 30 * SECOND, 74_999, 0, -HOUR, Number.NaN]) {
			for (const id of ids) {
				expect(renewDelayMs(id, lifetime)).toBeNull();
			}
		}
		// otherwise never sooner than a minute after provisioning
		for (const lifetime of [75 * SECOND, 80 * SECOND, 85 * SECOND, 90 * SECOND]) {
			for (const id of ids) {
				expect(renewDelayMs(id, lifetime)).toBeGreaterThanOrEqual(RENEW_MIN_DELAY_MS);
			}
		}
	});
});
