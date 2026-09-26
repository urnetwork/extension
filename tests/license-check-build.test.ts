import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
afterEach(() => {
	for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(modules: string[], haveSDK = true) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "extension license check ")));
	fixtures.push(root);
	const extension = path.join(root, "extension");
	const sdk = path.join(root, "sdk");
	const bin = path.join(root, "bin");
	fs.mkdirSync(path.join(extension, "scripts"), { recursive: true });
	fs.mkdirSync(bin);
	if (haveSDK) fs.mkdirSync(sdk);
	fs.copyFileSync(new URL("../scripts/check-licenses.js", import.meta.url), path.join(extension, "scripts/check-licenses.js"));
	fs.copyFileSync(new URL("../Makefile", import.meta.url), path.join(extension, "Makefile"));
	fs.writeFileSync(path.join(extension, "package.json"), '{"type":"module"}');
	for (const module of modules) {
		const dir = path.join(sdk, module);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "go.mod"), "module github.com/urnetwork/sdk\n");
	}
	// Stub only the Go process: execute the real Makefile and launcher, checking
	// exactly which module and gate they invoke, and that failures stay fatal.
	fs.writeFileSync(path.join(bin, "go"), `#!/usr/bin/env node
console.log("GO_ARGS=" + JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.LICENSE_GO_STATUS || 0));
`, { mode: 0o755 });
	return {
		sdk,
		run: (status = 0) => spawnSync("make", ["license-check"], {
			cwd: extension,
			encoding: "utf8",
			env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LICENSE_GO_STATUS: String(status) },
		}),
	};
}

describe("make license-check", () => {
	it.each(["", "v2026", "v2027"])("runs the strict extension check in SDK module %j", (module) => {
		const test = fixture([module]);
		const result = test.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(`GO_ARGS=${JSON.stringify(["-C", path.join(test.sdk, module), "run", "./licenses", "-check", "extension"])}`);
	});

	it("prefers the development module over leftover versioned directories", () => {
		const test = fixture(["", "v2026"]);
		const result = test.run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain(`GO_ARGS=${JSON.stringify(["-C", test.sdk, "run", "./licenses", "-check", "extension"])}`);
	});

	it("preserves the existing skip only when the sibling SDK is absent", () => {
		const result = fixture([], false).run();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("not checked out, skipping");
		expect(result.stdout).not.toContain("GO_ARGS=");
	});

	it.each([{ modules: [] }, { modules: ["v2026", "v2027"] }, { modules: ["js"] }])("fails closed for missing or ambiguous root modules $modules", ({ modules }) => {
		const result = fixture(modules).run();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("expected one SDK Go module");
		expect(result.stdout).not.toContain("GO_ARGS=");
	});

	it("does not hide a failed license check", () => {
		const result = fixture(["v2026"]).run(7);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("Error 7");
		expect(result.stdout).toContain("GO_ARGS=");
	});
});
