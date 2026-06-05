import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

const isFirefox = process.env.BROWSER_TARGET === "firefox";

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
	permissions: ["proxy", "storage", "alarms"],
	host_permissions: isFirefox
		? ["<all_urls>", "https://api.bringyour.com/*", "https://api-v4.bringyour.com/*"]
		: ["https://api.bringyour.com/*", "https://api-v4.bringyour.com/*"],
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
