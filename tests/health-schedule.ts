// The health check's one-minute schedule (background/index.ts) on a clock the
// test owns: each check runs a minute after the one before, as the alarm does,
// so a run of failures counts the way it does in a browser
// (utils/proxy-health.ts failureSpacingMs).
import type * as HealthModule from "../src/utils/proxy-health";

// any instant: the schedule only needs one that moves
export const SCHEDULE_START = Date.UTC(2026, 10, 11, 12, 0, 0);

export type MinuteSchedule = {
	now: () => number;
	advance: (ms: number) => void;
	// the next check of the schedule, a minute after the last
	check: (notify?: (reason: string) => void) => Promise<HealthModule.ProxyHealthOutcome>;
};

export function minuteSchedule(health: typeof HealthModule, start = SCHEDULE_START): MinuteSchedule {
	let t = start;
	const now = () => t;
	return {
		now,
		advance: (ms) => {
			t += ms;
		},
		check: (notify) => {
			t += 60_000;
			return health.performHealthCheck(notify, health.defaultProxyHealthSettings(), now);
		},
	};
}
