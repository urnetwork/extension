// Vitest configuration for the extension's unit tests.
//
// Deliberately standalone rather than merged with vite.config.ts: the build
// config is dominated by browser-packaging plugins (crxjs manifest handling,
// the geo content-script IIFE bundler, zip-pack) that have no meaning in a
// node test process and would drag manifest generation into every test run.
// What the tests DO need from the build config — the `@` source alias, the
// sdk source aliases (shared via sdk-source.ts), the in-repo elements
// package and TS handling — is replicated here. Keep the alias list in sync
// with vite.config.ts / tsconfig.app.json if it grows.
//
// Tests run in a plain node environment: the bridge background service uses no
// DOM, and every `chrome.*` surface is provided by tests/chrome-mock.ts. The
// popup's screens are rendered to html with react-dom/server, where the
// elements' Lit components render as their tags (lit's node build).
import path from "node:path";
import { defineConfig } from "vitest/config";
import { version } from "./package.json";
import { sdkAliases, sdkDedupe } from "./sdk-source";

export default defineConfig({
	// the build constants the sources read, as the Chrome build defines them
	define: {
		__EXTENSION_VERSION__: JSON.stringify(version),
		__EXTENSION_BROWSER_TARGET__: JSON.stringify("chrome"),
	},
	resolve: {
		alias: [
			...sdkAliases,
			{ find: "@urnetwork/elements/react", replacement: path.resolve(__dirname, "elements/src/react/index.ts") },
			{ find: "@urnetwork/elements/components", replacement: path.resolve(__dirname, "elements/src/components/index.ts") },
			{ find: "@", replacement: path.resolve(__dirname, "src") },
		],
		dedupe: sdkDedupe,
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
