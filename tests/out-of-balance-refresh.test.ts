// When the free data refreshes, as the out-of-data alert and its notification
// say it (utils/out-of-balance.ts): the apps' countdown to the next 00:00 UTC,
// in the apps' duration strings.
import { describe, expect, it } from "vitest";
import { installChromeMock, message } from "./chrome-mock";
import { freeRefreshCountdown, freeRefreshLine, nextFreeRefresh } from "../src/utils/out-of-balance";

installChromeMock();

describe("the free refresh", () => {
	const at = (iso: string) => Date.parse(iso);

	it("is the next 00:00 UTC", () => {
		expect(nextFreeRefresh(at("2026-11-11T18:47:30Z"))).toBe(at("2026-11-12T00:00:00Z"));
		expect(nextFreeRefresh(at("2026-11-11T00:00:00Z"))).toBe(at("2026-11-12T00:00:00Z"));
	});

	it("counts down in whole minutes, rounded up", () => {
		expect(freeRefreshCountdown(at("2026-11-11T18:47:30Z"))).toEqual({ hours: 5, minutes: 13 });
		expect(freeRefreshCountdown(at("2026-11-11T23:59:59Z"))).toEqual({ hours: 0, minutes: 1 });
	});

	it("reads as the apps' line", () => {
		expect(freeRefreshLine((key) => message(key), at("2026-11-11T18:47:30Z"))).toBe(
			"Free data refreshes in 5h 13m.",
		);
		expect(freeRefreshLine((key) => message(key), at("2026-11-11T23:30:00Z"))).toBe(
			"Free data refreshes in 30m.",
		);
		expect(freeRefreshLine((key) => message(key, "de"), at("2026-11-11T18:47:30Z"))).toBe(
			`${message("insufficient_balance_refreshes_in", "de").replace("{time}", "5 Std. 13 Min.")}`,
		);
	});
});
