import path from "node:path";
import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import zip from "vite-plugin-zip-pack";
import manifest from "./manifest.config.js";
import { name, version } from "./package.json";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

const isFirefox = process.env.BROWSER_TARGET === "firefox";
const outDir = isFirefox ? "dist-firefox" : "dist";

export default defineConfig({
	build: {
		outDir,
	},
	resolve: {
		alias: {
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
