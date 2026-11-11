// The extension's client info (src/utils/client-info.ts): the distribution is
// the build the extension was made as, which vite.config.ts names per
// BROWSER_TARGET. The server reads it, with device type web, for the
// account's onboarding platform.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_DEVICE_TYPE, EXTENSION_DISTRIBUTION, extensionClientInfoHeaders } from "../src/utils/client-info";

describe("client info", () => {
	it("is the web platform's app, as the build it was made as", () => {
		const viteConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
		expect(viteConfig).toContain('__EXTENSION_BROWSER_TARGET__: JSON.stringify(isFirefox ? "firefox" : "chrome")');
		expect(EXTENSION_DEVICE_TYPE).toBe("web");
		// the tests run as the Chrome build (vitest.config.ts)
		expect(EXTENSION_DISTRIBUTION).toBe("extension_chrome");
		const header = JSON.parse(extensionClientInfoHeaders()["X-UR-ClientInfo"]);
		expect(header.device_type).toBe("web");
		expect(header.distribution).toBe("extension_chrome");
	});
});
