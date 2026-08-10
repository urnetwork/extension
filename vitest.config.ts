// Vitest configuration for the extension's unit tests.
//
// Deliberately standalone rather than merged with vite.config.ts: the build
// config is dominated by browser-packaging plugins (crxjs manifest handling,
// the geo content-script IIFE bundler, zip-pack) that have no meaning in a
// node test process and would drag manifest generation into every test run.
// What the tests DO need from the build config — the `@` source alias and TS
// handling — is replicated here. Keep the alias list in sync with
// vite.config.ts / tsconfig.app.json if it grows.
//
// Tests run in a plain node environment: the bridge background service uses no
// DOM, and every `chrome.*` surface is provided by tests/chrome-mock.ts.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		setupFiles: ["tests/setup.ts"],
		// mocks/stubs (including the global fetch guard) are restored between
		// tests so no test can leak spies into the next
		restoreMocks: true,
		unstubGlobals: true,
	},
});
