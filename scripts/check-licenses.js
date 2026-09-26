// Run the SDK's strict license check in both development and release layouts.
// The release harness moves the root Go module into sdk/vNNNN; sdk/js stays put.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../sdk");

function fail(message) {
	console.error(`license-check: ${message}`);
	process.exit(1);
}

if (!fs.existsSync(sdkRoot)) {
	console.log("license-check: ../sdk not checked out, skipping");
	process.exit(0);
}

// Prefer the development module when present. Otherwise require exactly one
// versioned module: an incomplete or ambiguous checkout must not skip the gate.
const candidates = fs.existsSync(path.join(sdkRoot, "go.mod"))
	? [sdkRoot]
	: fs.readdirSync(sdkRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^v[0-9]+$/.test(entry.name))
		.map((entry) => path.join(sdkRoot, entry.name))
		.filter((dir) => fs.existsSync(path.join(dir, "go.mod")));

if (candidates.length !== 1) {
	fail(`expected one SDK Go module in ${sdkRoot} or its vNNNN directories; found ${candidates.length}`);
}

const result = spawnSync("go", ["-C", candidates[0], "run", "./licenses", "-check", "extension"], {
	stdio: "inherit",
});
if (result.error) fail(result.error.message);
process.exit(result.status ?? 1);
