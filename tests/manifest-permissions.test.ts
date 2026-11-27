// The manifest's permissions (owner, 2026-11-11: "accept recommendation a").
// The out-of-data notification needs the notifications permission. Made
// required, it would have reached every user, but an update that adds a
// required permission with a warning is disabled by the browser until the
// user accepts it, and the extension's proxy setting goes with it. So it is
// optional, and the popup's Turn on alerts asks for it. For Chrome and for
// Firefox (the same manifest.config.ts, BROWSER_TARGET=firefox; the Firefox
// patch script leaves both lists alone), the required permissions are the ones
// the store releases carry, and notifications is only optional.
import { afterEach, describe, expect, it, vi } from "vitest";

// the plugin's defineManifest returns the manifest it is given
vi.mock("@crxjs/vite-plugin", () => ({ defineManifest: (manifest: unknown) => manifest }));

// the required permissions of the store releases (v2026.10.30-1086064830),
// less "tabs" (owner decision 2026-11-27: only a legacy SSO tab listener used
// it; sign-in goes through chrome.identity.launchWebAuthFlow)
const REQUIRED = ["proxy", "storage", "alarms", "identity"];

type Permissions = { permissions?: string[]; optional_permissions?: string[] };

async function manifestFor(target: "chrome" | "firefox"): Promise<Permissions> {
	vi.resetModules();
	vi.stubEnv("BROWSER_TARGET", target === "firefox" ? "firefox" : "");
	const { default: manifest } = await import("../manifest.config");
	return manifest as unknown as Permissions;
}

describe("the manifest's permissions", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	for (const target of ["chrome", "firefox"] as const) {
		it(`${target}: the required permissions are unchanged, and notifications is optional only`, async () => {
			const manifest = await manifestFor(target);

			expect(manifest.permissions).toEqual(REQUIRED);
			expect(manifest.permissions).not.toContain("notifications");
			expect(manifest.optional_permissions).toEqual(["notifications"]);
		});

		it(`${target}: "tabs" is requested neither as required nor as optional`, async () => {
			const manifest = await manifestFor(target);

			expect(manifest.permissions).not.toContain("tabs");
			expect(manifest.optional_permissions ?? []).not.toContain("tabs");
		});
	}
});
