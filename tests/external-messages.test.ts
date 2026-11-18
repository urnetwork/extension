// The legacy external SET_JWT is gone (owner decision 2026-11-18). A web page
// on ur.io (externally_connectable) could message the background directly with
// SET_JWT {jwt}, and the background stored the page's own token as the
// extension's sign-in, so the extension shared the page's session and the
// page's sign-out signed it out. ur.io sets the extension up over the
// content-channel bridge with a sign-in code instead (SETUP, own-session tests),
// so the path and its externally_connectable entry are removed: an external
// SET_JWT reaches nothing and changes no stored identity.
//
// The real background entry point is loaded on the chrome mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import { makeJwt, NETWORK_ID } from "./bridge/harness";

// the plugin's defineManifest returns the manifest it is given
vi.mock("@crxjs/vite-plugin", () => ({ defineManifest: (manifest: unknown) => manifest }));

const STORED = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-1" });
const PAGE_TOKEN = makeJwt({ network_id: NETWORK_ID, network_name: "testnet", user_id: "user-2" });

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("an external SET_JWT", () => {
	let mock: ChromeMock;

	beforeEach(async () => {
		vi.resetModules();
		mock = installChromeMock();
		vi.doMock("../src/bridge/api", () => ({
			authNetworkClient: vi.fn(),
			removeNetworkClient: vi.fn(async () => true),
			activeProxyClientIds: vi.fn(async () => null),
			subscriptionBalance: vi.fn(async () => null),
		}));
		// the background's start (restore after 2 s) never runs here
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		mock.seedStorage({ by_jwt: STORED, network_name: "testnet" });
		await import("../src/background/index");
		await settle();
		mock.resetCalls();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("is ignored: nothing listens, and the stored identity stays as it was", async () => {
		const sendResponse = vi.fn();
		for (const listener of mock.onMessageExternalListeners) {
			listener(
				{ type: "SET_JWT", jwt: PAGE_TOKEN, networkName: "othernet" },
				{ url: "https://ur.io/app" } as chrome.runtime.MessageSender,
				sendResponse,
			);
		}
		await settle();

		expect(mock.getStored("by_jwt")).toBe(STORED);
		expect(mock.getStored("network_name")).toBe("testnet");
		expect(sendResponse).not.toHaveBeenCalled();
		expect(mock.runtimeMessages).not.toContainEqual(expect.objectContaining({ type: "JWT_RECEIVED" }));
		expect(mock.onMessageExternalListeners).toHaveLength(0);
	});

	for (const target of ["chrome", "firefox"] as const) {
		it(`${target}: the manifest lets no web page message the background`, async () => {
			vi.resetModules();
			vi.stubEnv("BROWSER_TARGET", target === "firefox" ? "firefox" : "");
			const { default: manifest } = await import("../manifest.config");
			expect(manifest).not.toHaveProperty("externally_connectable");
		});
	}
});
