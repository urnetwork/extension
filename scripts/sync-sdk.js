// @ts-nocheck
// Make sure the sibling sdk checkout's wasm is built and current before a
// build or dev server copies it into the extension (vite.config.ts copies
// ../sdk/js/wasm/* to wasm/).
//
// The extension consumes the URnetwork JS SDK from the sibling checkout
// (../sdk/js, see sdk-source.ts) — its TS source through vite/tsconfig/vitest
// aliases, and its wasm from here. The TS needs no build; the wasm does, and
// it is a gitignored build artifact of the sdk, so this script:
//   1. builds it (`make -C ../sdk/js build_wasm`) when it is missing or older
//      than the sdk's Go sources / embedded license list
//   2. fails the build when the wasm lacks an export the popup calls, so a
//      stale wasm fails here instead of in a user's browser
//
// Env (the same switches as mmm/ur.io's sync-sdk.mjs):
//   UR_SKIP_SDK_BUILD=1   never invoke the Go toolchain: use the existing wasm
//                         (fail if there is none, warn if it looks stale). The
//                         release pipeline sets this: it built the wasm itself
//                         in the same run (build/all/run.sh, sdk/js make package).
//   UR_FORCE_SDK_BUILD=1  always rebuild the wasm
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SDK_JS = path.resolve(__dirname, "../../sdk/js");
const SDK_ROOT = path.resolve(SDK_JS, "..");
const WASM = path.join(SDK_JS, "wasm", "sdk.wasm");
const WASM_EXEC = path.join(SDK_JS, "wasm", "wasm_exec.js");

// URnetworkGetLicenses: the Licenses screen (utils/licenses.ts)
// URnetworkFilteredLocationsFromResult: the location list (utils/locations.ts)
const REQUIRED_SYMBOLS = ["URnetworkGetLicenses", "URnetworkFilteredLocationsFromResult"];

function fail(message) {
	console.error(`[sync-sdk] ${message}`);
	process.exit(1);
}

if (!fs.existsSync(path.join(SDK_JS, "src", "index.ts"))) {
	fail(
		`the sdk is not checked out at ${SDK_JS}.\n` +
			"The extension builds against the sdk beside it (~/urnetwork/sdk); clone it there.",
	);
}

// tsconfig.sdk.json type-checks the sdk source against the sdk's own dev
// types (react), installed by `npm ci` in sdk/js (`make -C ../sdk/js build`)
if (!fs.existsSync(path.join(SDK_JS, "node_modules", "@types", "react"))) {
	fail(`the sdk's dev dependencies are not installed; run \`npm ci --prefix ${SDK_JS}\` first.`);
}

function newestMtime(dir, recurse) {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", "build", "dist", "wasm"].includes(entry.name)) continue;
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (recurse) newest = Math.max(newest, newestMtime(p, true));
		} else if (entry.name.endsWith(".go") || entry.name === "license.yml" || entry.name === "go.mod") {
			newest = Math.max(newest, fs.statSync(p).mtimeMs);
		}
	}
	return newest;
}

// the wasm is compiled from sdk/js and the sdk package above it; license.yml
// is go:embed-ed into the sdk package (the Licenses screen)
const haveWasm = fs.existsSync(WASM) && fs.existsSync(WASM_EXEC);
const stale =
	haveWasm &&
	Math.max(newestMtime(SDK_JS, true), newestMtime(SDK_ROOT, false)) > fs.statSync(WASM).mtimeMs;

if (process.env.UR_SKIP_SDK_BUILD === "1") {
	if (!haveWasm) {
		fail(`no sdk wasm at ${WASM} and UR_SKIP_SDK_BUILD=1 — run \`make -C ${SDK_JS} build_wasm\` first.`);
	}
	if (stale) console.warn("[sync-sdk] the sdk wasm is older than its sources; UR_SKIP_SDK_BUILD=1, using it as-is");
} else if (!haveWasm || stale || process.env.UR_FORCE_SDK_BUILD === "1") {
	const why = !haveWasm ? "missing" : stale ? "stale" : "forced";
	console.log(`[sync-sdk] building the sdk wasm (${why}): make -C ${SDK_JS} build_wasm`);
	try {
		execFileSync("make", ["build_wasm"], { cwd: SDK_JS, stdio: "inherit" });
	} catch {
		fail("the sdk wasm build failed (it needs the Go toolchain: GOOS=js GOARCH=wasm).");
	}
}

const bytes = fs.readFileSync(WASM);
for (const symbol of REQUIRED_SYMBOLS) {
	if (!bytes.includes(Buffer.from(symbol, "utf8"))) {
		fail(`the sdk wasm does not export ${symbol}; rebuild it: make -C ${SDK_JS} build_wasm`);
	}
}
console.log(
	`[sync-sdk] sdk wasm ${(bytes.length / (1024 * 1024)).toFixed(1)} MB at ${path.relative(process.cwd(), WASM)} (${REQUIRED_SYMBOLS.join(" + ")} ✓)`,
);
