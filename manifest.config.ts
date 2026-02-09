import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
	manifest_version: 3,
	name: "URnetwork",
	version: pkg.version,
	default_locale: "en",
	icons: {
		48: "public/logo.png",
	},
	action: {
		default_icon: {
			48: "public/logo.png",
		},
		default_popup: "src/popup/index.html",
	},
	// content_scripts: [
	//   {
	//     js: ["src/content/main.ts"],
	//     matches: ["https://*/*"],
	//   },
	// ],
	// permissions: ["sidePanel", "contentSettings"],
	background: {
		service_worker: "src/background/index.ts",
		type: "module",
	},
	permissions: ["proxy", "storage"],
	//
	host_permissions: ["<all_urls>"],
	web_accessible_resources: [
		{
			resources: ["wasm/sdk.wasm", "wasm/wasm_exec.js"],
			matches: ["<all_urls>"],
		},
	],
	externally_connectable: {
		matches: [
			"https://localhost:*/*",
			"https://ur.io/*",
			"https://app.ur.network/*",
		],
	},
	// side_panel: {
	//   default_path: "src/sidepanel/index.html",
	// },
});
