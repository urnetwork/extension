// The one sdk wasm instance of the popup.
//
// The wasm (dist/wasm/, copied from ../sdk/js/wasm by vite.config.ts) carries
// the sdk's shared logic the popup renders: the location list's grouping and
// order (URNetwork#filteredLocations, see utils/locations.ts) and the license
// list (URNetwork#licenses, see utils/licenses.ts). It is tens of MB, so it is
// loaded once, never on the first paint's critical path (preloadSdk), and kept
// for the rest of the popup's life. The service worker never loads it.
//
// MV3's default extension-page CSP cannot compile wasm; manifest.config.ts adds
// 'wasm-unsafe-eval' for this.
import { URNetwork } from "@urnetwork/sdk";

let loading: Promise<URNetwork> | null = null;

/**
 * The initialized sdk. The first call loads the wasm; later calls share it. A
 * failure is not cached, so a retry loads again.
 */
export function loadSdk(): Promise<URNetwork> {
	if (!loading) {
		loading = URNetwork.init({
			wasmUrl: chrome.runtime.getURL("wasm/sdk.wasm"),
			wasmExecUrl: chrome.runtime.getURL("wasm/wasm_exec.js"),
		}).catch((error: unknown) => {
			loading = null;
			throw error;
		});
	}
	return loading;
}

/**
 * Start loading the wasm after the next frame, so the popup paints first and
 * the download/compile overlaps the api calls that need it. Errors surface
 * from the loadSdk() call that consumes it.
 */
export function preloadSdk(): void {
	const start = () => {
		loadSdk().catch(() => {});
	};
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => setTimeout(start, 0));
	} else {
		setTimeout(start, 0);
	}
}
