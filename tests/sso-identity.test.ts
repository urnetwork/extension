// SSO signs in through chrome.identity.launchWebAuthFlow only (owner decision
// 2026-11-27: the legacy tab listener and the "tabs" permission are removed).
// The real background entry point is loaded on the chrome mock, which has no
// tabs namespace: START_SSO launches the identity flow, the redirect URL's code
// is redeemed with signInWithCode, and the popup is answered.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";

vi.mock("@crxjs/vite-plugin", () => ({ defineManifest: (manifest: unknown) => manifest }));

const settle = async () => {
	for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

describe("SSO via chrome.identity", () => {
	let mock: ChromeMock;
	let signInWithCode: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.resetModules();
		mock = installChromeMock();
		signInWithCode = vi.fn(async () => ({ success: true }));
		vi.doMock("../src/bridge/background", async (importOriginal) => ({
			...(await importOriginal<typeof import("../src/bridge/background")>()),
			signInWithCode,
		}));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		await import("../src/background/index");
		await settle();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.doUnmock("../src/bridge/background");
	});

	function startSso(): Promise<unknown> {
		return new Promise((resolve) => {
			let async = false;
			for (const responder of mock.onMessageResponders) {
				if (responder({ type: "START_SSO" }, {}, resolve) === true) async = true;
			}
			expect(async).toBe(true);
		});
	}

	it("completes from the identity redirect URL, with no tabs API present", async () => {
		expect((mock.chrome as unknown as Record<string, unknown>).tabs).toBeUndefined();
		const launched: string[] = [];
		mock.chrome.identity.launchWebAuthFlow = ((
			options: { url: string },
			callback: (responseUrl?: string) => void,
		) => {
			launched.push(options.url);
			const state = new URL(options.url).searchParams.get("state");
			callback(`https://test-extension-id.chromiumapp.org/sso-complete#code=abc123&state=${state}`);
		}) as typeof chrome.identity.launchWebAuthFlow;

		const response = await startSso();
		await settle();

		expect(launched).toHaveLength(1);
		expect(new URL(launched[0]).searchParams.get("redirect_uri")).toBe(
			"https://test-extension-id.chromiumapp.org/sso-complete",
		);
		expect(signInWithCode).toHaveBeenCalledWith("abc123");
		expect(response).toEqual({ success: true });
	});

	it("rejects a redirect whose state does not match", async () => {
		mock.chrome.identity.launchWebAuthFlow = ((
			_options: { url: string },
			callback: (responseUrl?: string) => void,
		) => {
			callback("https://test-extension-id.chromiumapp.org/sso-complete#code=abc123&state=wrong");
		}) as typeof chrome.identity.launchWebAuthFlow;

		const response = await startSso();

		expect(signInWithCode).not.toHaveBeenCalled();
		expect(response).toEqual({ success: false, error: "SSO flow failed" });
	});
});
