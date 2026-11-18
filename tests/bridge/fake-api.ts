// A fake URnetwork api for the extension's own sign-in (src/utils/own-sign-in.ts),
// behind the real sdk client: the global fetch the client calls is replaced by
// routes the test writes, keyed "METHOD /path", and every request is recorded
// with its body, bearer and client info. A route answers a status and json,
// throws (no answer: the client's "network" failure), or hangs until the
// client aborts it (its timeout). A request with no route fails the test.
//
// The bridge's other network surface (src/bridge/api.ts: auth-client,
// remove-client) stays mocked at the module boundary by tests/bridge/harness.ts.
import { vi } from "vitest";
import { makeJwt } from "./harness";

export type ApiCall = {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
	authorization: string | null;
	clientInfo: string | null;
};

export type ApiAnswer = { status?: number; json?: unknown } | "hang";

export type ApiRoute = (call: ApiCall) => ApiAnswer | Promise<ApiAnswer>;

export type FakeApi = {
	calls: ApiCall[];
	/** the calls to one route, in order */
	callsTo: (route: string) => ApiCall[];
};

export function serveApi(routes: Record<string, ApiRoute>): FakeApi {
	const calls: ApiCall[] = [];
	vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const call: ApiCall = {
			method: init?.method ?? "GET",
			path: url.pathname,
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
			authorization: headers.Authorization ?? null,
			clientInfo: headers["X-UR-ClientInfo"] ?? null,
		};
		calls.push(call);
		const route = routes[`${call.method} ${call.path}`];
		if (!route) {
			throw new Error(`fake api: no route for ${call.method} ${call.path}`);
		}
		const answer = await route(call);
		if (answer === "hang") {
			// no answer until the client gives up (a fetch honors its signal)
			return new Promise<Response>((_, reject) => {
				const signal = init?.signal;
				const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				if (signal?.aborted) abort();
				signal?.addEventListener("abort", abort, { once: true });
			});
		}
		return new Response(JSON.stringify(answer.json ?? {}), {
			status: answer.status ?? 200,
			headers: { "Content-Type": "application/json" },
		});
	});
	return {
		calls,
		callsTo: (route) => calls.filter((call) => `${call.method} ${call.path}` === route),
	};
}

// A fetch failure, as a route throws it: the request never got an answer.
export function noAnswer(): never {
	throw new TypeError("fetch failed");
}

export const DAY_S = 24 * 60 * 60;

/**
 * A network token as the server signs it (unsigned here: the extension is
 * decode-only), issued at `iatS` and living 30 days.
 */
export function networkToken(claims: Record<string, unknown>, iatS = Math.floor(Date.now() / 1000)): string {
	return makeJwt({ iat: iatS, exp: iatS + 30 * DAY_S, ...claims });
}
