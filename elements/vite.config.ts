import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";
import dts from "vite-plugin-dts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	plugins: [dts({ include: ["src/**/*"], outDir: "dist" })],
	build: {
		lib: {
			entry: {
				// Web components - single entry point
				components: resolve(__dirname, "src/components/index.ts"),
				// React wrappers - single entry point
				react: resolve(__dirname, "src/react/index.ts"),
				styles: resolve(__dirname, "src/styles.ts"),
			},
			formats: ["es"],
		},
		rollupOptions: {
			external: [
				"lit",
				"lit/static-html.js",
				"react",
				"react-dom",
				"@lit/react",
				"react/jsx-runtime",
			],
			output: {
				assetFileNames: (assetInfo) => {
					if (assetInfo.name && assetInfo.name.endsWith(".css")) {
						return "assets/styles.css";
					}
					return "assets/[name][extname]";
				},
			},
		},
		assetsInlineLimit: 100000000,
		cssCodeSplit: true,
	},
});
