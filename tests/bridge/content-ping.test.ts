// The content script answers the page's PING itself (src/bridge/content.ts),
// so its answer is the one the page reads first: it says what this version's
// bridge does (protocol.ts BRIDGE_CAPABILITIES), and the page keys off it. An
// answer without them told ur.io nothing, and it kept handing the extension
// its own token (SETUP {jwt}) instead of a sign-in code.
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeWindow {
	location = { origin: "https://ur.io" };
	posts: Array<Record<string, unknown>> = [];
	listeners: Array<(event: Record<string, unknown>) => void> = [];

	addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
		if (type === "message") this.listeners.push(listener);
	}

	postMessage(message: Record<string, unknown>): void {
		this.posts.push(structuredClone(message));
	}

	deliver(data: Record<string, unknown>): void {
		for (const listener of this.listeners) listener({ data, origin: this.location.origin, source: this });
	}
}

describe("the content script's PING", () => {
	let windowObject: FakeWindow;
	let connects: number;

	beforeEach(async () => {
		vi.resetModules();
		windowObject = new FakeWindow();
		connects = 0;
		vi.stubGlobal("window", windowObject);
		vi.stubGlobal("document", { documentElement: { dataset: {} } });
		vi.stubGlobal("chrome", {
			runtime: {
				id: "extension-id",
				lastError: undefined,
				getManifest: () => ({ version: "1.2.3" }),
				connect: () => {
					connects++;
					return {
						onMessage: { addListener: () => {} },
						onDisconnect: { addListener: () => {} },
						postMessage: () => {
							throw new Error("PING never reaches the background");
						},
					};
				},
			},
		});
		await import("../../src/bridge/content");
	});

	it("answers with the version and what the bridge does: SETUP with a sign-in code, RENEW_SESSION", () => {
		windowObject.deliver({ urnb: 1, dir: "req", id: "p-1", verb: "PING" });

		expect(windowObject.posts.find((post) => post.dir === "res")).toEqual({
			urnb: 1,
			from: "urnetwork-extension",
			dir: "res",
			id: "p-1",
			ok: true,
			data: { version: "1.2.3", setupAuthCode: true, renewSession: true },
		});
		// the bridge port opened at load, and the PING did not use it
		expect(connects).toBe(1);
	});
});
