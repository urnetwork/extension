// Origin gating at port-connect time. The bridge accepts a port only when the
// sender url passes isAllowedOrigin (ur.io / ur.network / localhost, exact or
// subdomain); everything else is disconnected before any message listener is
// registered — so no verb, including REFRESH_JWT, is reachable from a
// disallowed origin.
import { beforeEach, describe, expect, it } from "vitest";
import {
	createBridgeHarness,
	makeJwt,
	NETWORK_ID,
	type BridgeHarness,
} from "./harness";

describe("bridge origin gating", () => {
	let h: BridgeHarness;

	beforeEach(async () => {
		h = await createBridgeHarness();
	});

	it.each([
		"https://ur.io/app",
		"https://app.ur.io/somewhere",
		"https://ur.network/",
		"http://localhost:5173/app",
	])("accepts %s and serves requests", async (url) => {
		const app = h.connect(url);
		expect(app.disconnectedByService).toBe(false);
		expect(app.messageListenerCount()).toBe(1);
		expect(h.bridge.hasConnectedApp()).toBe(true);
		const res = await app.request("PING");
		expect(res.ok).toBe(true);
	});

	it.each([
		"https://evil.example/",
		// suffix spoofs of the allowlist
		"https://ur.io.evil.example/",
		"https://notur.io/",
		"not a url",
	])("disconnects %s before registering any listener", (url) => {
		const app = h.connect(url);
		expect(app.disconnectedByService).toBe(true);
		expect(app.messageListenerCount()).toBe(0);
		expect(h.bridge.hasConnectedApp()).toBe(false);
	});

	it("disconnects a port with no sender url", () => {
		const app = h.connect(null);
		expect(app.disconnectedByService).toBe(true);
		expect(app.messageListenerCount()).toBe(0);
	});

	it("ignores ports with a different name without touching them", () => {
		const app = h.connect("https://ur.io/app", "some-other-port");
		expect(app.disconnectedByService).toBe(false);
		expect(app.messageListenerCount()).toBe(0);
		expect(h.bridge.hasConnectedApp()).toBe(false);
	});

	it("REFRESH_JWT is unreachable from a disallowed origin", async () => {
		const app = h.connect("https://evil.example/");
		await expect(
			app.request("REFRESH_JWT", { byJwt: makeJwt({ network_id: NETWORK_ID }) }),
		).rejects.toThrow(/no message listener/);
		expect(h.chrome.getStored("by_jwt")).toBeUndefined();
	});
});
