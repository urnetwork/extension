// Global test setup (wired via vitest.config.ts setupFiles).
//
// Network guard: the suite must be deterministic and offline. Nothing under
// test should ever reach the real network — api calls are mocked at the module
// boundary (see tests/bridge/harness.ts) — so any fetch that slips through is
// a test bug, and it fails loudly here instead of hitting api.bringyour.com.
import { beforeEach, vi } from "vitest";

beforeEach(() => {
	vi.stubGlobal("fetch", (input: unknown) => {
		return Promise.reject(
			new Error(`network disabled in tests: fetch(${String(input)})`),
		);
	});
});
