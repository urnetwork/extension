// The URnetwork JS SDK is consumed from SOURCE, from the sdk checkout beside
// this repo (~/urnetwork is a monoroot of sibling repos: sdk/, extension/, …),
// never from the npm registry — the same wiring as mmm/ur.io. The published
// package lags the sibling checkout (the generated api client, the license
// list and the location grouping all postdate the last registry release), and
// the release pipeline (build/all/run.sh) builds this extension in the same
// run and from the same commit as the sdk, so the sibling is also what a
// release ships.
//
// Shared by vite.config.ts and vitest.config.ts; tsconfig.app.json mirrors the
// aliases as `paths`. The sdk's TS surface has no runtime npm dependencies but
// react (a peer), which must resolve to THIS package's react — see `dedupe`.
// The wasm artifacts come from ../sdk/js/wasm (scripts/sync-sdk.js builds
// them when missing or stale).
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SDK_JS = path.resolve(here, "../sdk/js");

// exact-match aliases, one per package export (sdk/js/package.json "exports")
export const sdkAliases = [
	{ find: /^@urnetwork\/sdk\/client$/, replacement: path.join(SDK_JS, "src/client.ts") },
	{ find: /^@urnetwork\/sdk\/react$/, replacement: path.join(SDK_JS, "src/react/index.ts") },
	{ find: /^@urnetwork\/sdk$/, replacement: path.join(SDK_JS, "src/index.ts") },
];

// the sdk's react hooks import "react"; resolved from the sdk's directory that
// would be sdk/js/node_modules/react (its dev copy), a second React
export const sdkDedupe = ["react", "react-dom"];
