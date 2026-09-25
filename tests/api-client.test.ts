// The hand-written api calls now go through the sdk's generated client
// (@urnetwork/sdk/client). These pin the wire behavior the old fetch code had
// — same endpoints, same bearer token, same error results the bridge and the
// popup read — against a stubbed fetch (tests/setup.ts disables the network).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock } from "./chrome-mock";
import { authNetworkClient, removeNetworkClient } from "../src/bridge/api";
import { buildAuthParams } from "../src/utils/auth-params";

type Call = { url: string; method: string; headers: Headers; body: unknown };

function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
		};
		calls.push(call);
		return respond(call);
	});
	return calls;
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
	installChromeMock();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("bridge authNetworkClient", () => {
	it("POSTs the auth params to /network/auth-client with the given jwt", async () => {
		const calls = stubFetch(() =>
			json(200, {
				by_client_jwt: "client.jwt",
				proxy_config_result: { auth_token: "t", instance_id: "i", proxy_host: "h", https_proxy_port: 443 },
			}),
		);
		const args = buildAuthParams();
		const result = await authNetworkClient(args, "network.jwt");

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://api.bringyour.com/network/auth-client");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers.get("Authorization")).toBe("Bearer network.jwt");
		expect(calls[0].body).toEqual(JSON.parse(JSON.stringify(args)));
		expect(result.by_client_jwt).toBe("client.jwt");
		expect(result.proxy_config_result?.instance_id).toBe("i");
		expect(result.error).toBeFalsy();
	});

	it("resolves a handled failure (200 with error) as the result's error", async () => {
		stubFetch(() => json(200, { error: { message: "limit", client_limit_exceeded: true } }));
		const result = await authNetworkClient(buildAuthParams(), "jwt");
		expect(result.proxy_config_result).toBeNull();
		expect(result.error).toEqual({ message: "limit", client_limit_exceeded: true });
	});

	it("maps a non-2xx to the old status error, 402 to upgrade_required", async () => {
		stubFetch(() => json(402, { error: { message: "payment required" } }));
		expect(await authNetworkClient(buildAuthParams(), "jwt")).toEqual({
			proxy_config_result: null,
			error: { message: "HTTP error! status: 402", client_limit_exceeded: false, upgrade_required: true },
		});

		stubFetch(() => json(500, {}));
		const result = await authNetworkClient(buildAuthParams(), "jwt");
		expect(result.error?.message).toBe("HTTP error! status: 500");
		expect(result.error?.upgrade_required).toBe(false);
	});

	it("resolves a network failure as an error result, without replaying the POST", async () => {
		const calls = stubFetch(() => {
			throw new TypeError("Failed to fetch");
		});
		const result = await authNetworkClient(buildAuthParams(), "jwt");
		expect(calls).toHaveLength(1);
		expect(result.proxy_config_result).toBeNull();
		expect(result.error?.client_limit_exceeded).toBe(false);
		expect(result.error?.message).toBeTruthy();
	});
});

describe("bridge removeNetworkClient", () => {
	it("POSTs the client id to /network/remove-client with the given jwt", async () => {
		const calls = stubFetch(() => json(200, {}));
		await removeNetworkClient("client-1", "network.jwt");
		expect(calls[0].url).toBe("https://api.bringyour.com/network/remove-client");
		expect(calls[0].method).toBe("POST");
		expect(calls[0].headers.get("Authorization")).toBe("Bearer network.jwt");
		expect(calls[0].body).toEqual({ client_id: "client-1" });
	});

	it("is best effort: failures never reject", async () => {
		stubFetch(() => json(401, {}));
		await expect(removeNetworkClient("c", "jwt")).resolves.toBeUndefined();
		stubFetch(() => {
			throw new TypeError("offline");
		});
		await expect(removeNetworkClient("c", "jwt")).resolves.toBeUndefined();
	});
});

describe("fetchIpInfo", () => {
	it("reads /my-ip-info from the api-v4 host, unauthenticated", async () => {
		vi.resetModules();
		const calls = stubFetch(() =>
			json(200, {
				info: { ip: "203.0.113.9", location: { city: "Berlin", region: "Berlin", country: { code: "de", name: "Germany" } } },
				connected_to_network: true,
			}),
		);
		const { fetchIpInfo } = await import("../src/utils/ip-info");
		expect(await fetchIpInfo()).toEqual({
			ip: "203.0.113.9",
			city: "Berlin",
			region: "Berlin",
			countryCode: "DE",
			countryName: "Germany",
			connectedToNetwork: true,
		});
		expect(calls[0].url).toBe("https://api-v4.bringyour.com/my-ip-info");
		expect(calls[0].method).toBe("GET");
		expect(calls[0].headers.get("Authorization")).toBeNull();
	});

	it("rejects on a non-2xx, once (no retry)", async () => {
		vi.resetModules();
		const calls = stubFetch(() => json(503, {}));
		const { fetchIpInfo } = await import("../src/utils/ip-info");
		await expect(fetchIpInfo()).rejects.toThrow();
		expect(calls).toHaveLength(1);
	});
});
