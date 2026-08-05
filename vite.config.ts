import path from "node:path";
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";
import zip from "vite-plugin-zip-pack";
import manifest from "./manifest.config.js";
import { name, version } from "./package.json";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const isFirefox = process.env.BROWSER_TARGET === "firefox";
const outDir = isFirefox ? "dist-firefox" : "dist";

// The geolocation override's two content scripts, built outside crxjs.
//
// crxjs emits every content script as an ES module plus an async loader that
// dynamic-imports it. That is fine for the ur.io bridge, but fatal for
// geo-main.js: a MAIN-world script has no chrome.runtime to build the URL
// with, a dynamic import from the page's realm is subject to the *page's* CSP,
// and awaiting one forfeits document_start — the whole point of the patch.
// So both files are bundled here as self-contained IIFEs under fixed names,
// hidden from crxjs during the manifest transform and put back with those
// names at generateBundle.
const GEO_SCRIPTS = [
	{ entry: "src/content/geo-main.ts", fileName: "geo-main.js" },
	{ entry: "src/content/geo-config.ts", fileName: "geo-config.js" },
];

type ContentScript = { js?: string[] };

function geoContentScripts(): Plugin {
	let held: ContentScript[] = [];

	const plugin: Plugin = {
		// enforce + position in the plugins array matter: crxjs's own post
		// plugins throw on a content script filename they did not emit, so these
		// entries have to go back last.
		name: "crx:geo-content-scripts",
		apply: "build",
		enforce: "post",
		async generateBundle() {
			for (const script of GEO_SCRIPTS) {
				const built = (await build({
					configFile: false,
					logLevel: "warn",
					build: {
						write: false,
						emptyOutDir: false,
						// unminified on purpose: this runs in every page and both
						// stores review it by eye
						minify: false,
						target: ["chrome111", "firefox128"],
						lib: {
							entry: path.resolve(__dirname, script.entry),
							formats: ["iife"],
							name: "urnetworkGeo",
							fileName: () => script.fileName,
						},
					},
				})) as unknown;
				// vite returns one result per output, and wraps them in an array
				// depending on version/config
				const results = (Array.isArray(built) ? built : [built]) as Array<{
					output?: Array<{ type: string; code?: string }>;
				}>;
				const chunk = results
					.flatMap((result) => result.output ?? [])
					.find((item) => item.type === "chunk");
				if (!chunk?.code) {
					throw new Error(`failed to bundle ${script.entry}`);
				}
				this.emitFile({ type: "asset", fileName: script.fileName, source: chunk.code });
			}
		},
	};

	// crxjs manifest hooks — not part of vite's Plugin type
	return Object.assign(plugin, {
		transformCrxManifest(crxManifest: { content_scripts?: ContentScript[] }) {
			const scripts = crxManifest.content_scripts ?? [];
			held = scripts.filter((script) =>
				(script.js ?? []).some((file) => GEO_SCRIPTS.some((geo) => geo.fileName === file)),
			);
			crxManifest.content_scripts = scripts.filter((script) => !held.includes(script));
			return crxManifest;
		},
		renderCrxManifest(crxManifest: { content_scripts?: ContentScript[] }) {
			crxManifest.content_scripts = [...(crxManifest.content_scripts ?? []), ...held];
			return crxManifest;
		},
	});
}

export default defineConfig({
	define: {
		__EXTENSION_VERSION__: JSON.stringify(version),
	},
	build: {
		outDir,
	},
	resolve: {
		alias: {
			// elements is maintained in-repo under elements/ and consumed
			// directly from source
			"@urnetwork/elements/styles.css": `${path.resolve(__dirname, "elements/src/index.css")}`,
			"@urnetwork/elements/react": `${path.resolve(__dirname, "elements/src/react/index.ts")}`,
			"@urnetwork/elements/components": `${path.resolve(__dirname, "elements/src/components/index.ts")}`,
			"@": `${path.resolve(__dirname, "src")}`,
		},
	},
	plugins: [
		react(),
		crx({ manifest }),
		viteStaticCopy({
			targets: [
				{
					src: "node_modules/@urnetwork/sdk-js/wasm/*",
					dest: "wasm",
				},
			],
		}),
		geoContentScripts(),
		zip({
			inDir: outDir,
			outDir: "release",
			outFileName: isFirefox
				? `crx-${name.replace("/", "-")}-${version}-firefox.zip`
				: `crx-${name.replace("/", "-")}-${version}.zip`,
			filter: (fileName) => !fileName.includes(".vite"),
		}),
		tailwindcss(),
	],
	server: {
		cors: {
			origin: [/chrome-extension:\/\//],
		},
	},
});
