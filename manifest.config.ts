import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

const isFirefox = process.env.BROWSER_TARGET === "firefox";

// `match_origin_as_fallback` is a real MV3 content-script key (Chrome 99+,
// Firefox 128+) that crxjs's manifest types predate. Spread in so the rest of
// the literal keeps its type checking.
const matchOriginAsFallback = { match_origin_as_fallback: true };

export default defineManifest({
	manifest_version: 3,
	name: "URnetwork",
	version: pkg.version,
	default_locale: "en",
	icons: {
		16: "logo.png",
		32: "logo.png",
		48: "logo.png",
		128: "logo.png",
	},
	action: {
		default_icon: {
			16: "logo.png",
			32: "logo.png",
			48: "logo.png",
			128: "logo.png",
		},
		default_popup: "src/popup/index.html",
	},
	background: isFirefox
		? {
			scripts: ["src/background/index.ts"],
			type: "module",
		}
		: {
			service_worker: "src/background/index.ts",
			type: "module",
		},
	permissions: ["proxy", "storage", "alarms", "tabs", "identity"],
	// App content-channel bridge: relays window.postMessage from the ur.io app
	// to the background over a Port. The only page↔extension channel that works
	// on Firefox too (externally_connectable is Chromium-only for web pages).
	content_scripts: [
		{
			matches: [
				"https://ur.io/*",
				"https://app.ur.network/*",
				// local development of the ur.io app
				"http://localhost/*",
			],
			js: ["src/bridge/content.ts"],
			run_at: "document_start",
			all_frames: false,
		},
		// Geolocation override (opt-in, off by default — see utils/geo-sync.ts).
		// Both files are built outside crxjs by the `crx:geo-content-scripts`
		// plugin in vite.config.ts and referenced by their final names: crxjs
		// wraps content scripts in an async dynamic-import loader, which a
		// MAIN-world script cannot use (no chrome.runtime, page CSP) and which
		// would forfeit document_start.
		{
			// MAIN is the only world the page can see. document_start so the
			// patch is in place before any page script runs; all_frames because
			// each same-origin frame is its own realm; match_origin_as_fallback
			// to reach about:blank / srcdoc / data: frames (Chrome 99+,
			// Firefox 128+ — the same floor as `world`, which our
			// strict_min_version already pins).
			matches: ["<all_urls>"],
			js: ["geo-main.js"],
			world: "MAIN",
			run_at: "document_start",
			all_frames: true,
			...matchOriginAsFallback,
		},
		{
			// ISOLATED companion: MAIN has no chrome.*, so this reads the config
			// out of chrome.storage.local and hands it over the shared DOM.
			matches: ["<all_urls>"],
			js: ["geo-config.js"],
			run_at: "document_start",
			all_frames: true,
			...matchOriginAsFallback,
		},
	],
	host_permissions: ["<all_urls>"],
	web_accessible_resources: [
		{
			resources: ["wasm/sdk.wasm", "wasm/wasm_exec.js"],
			matches: ["<all_urls>"],
		},
	],
	externally_connectable: {
		matches: ["https://ur.io/*", "https://app.ur.network/*"],
	},
	...(isFirefox
		? {
			browser_specific_settings: {
				gecko: {
					id: "urnetwork@bringyour.com",
					strict_min_version: "128.0",
					data_collection_permissions: {
						required: ["none"],
					},
				},
			},
		}
		: {}),
});
