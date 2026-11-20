// The shared pieces of the extension's own sign-in (owner decision 2026-11-18):
// the redemption's request id and its one resend (src/utils/own-sign-in.ts),
// the bounded server sign-out, and how the popup asks for a code sign-in and
// words a refusal (src/utils/code-sign-in.ts). The popup used the sdk's
// useAuthCodeLogin, which sent no request id (a lost answer cost the code)
// and showed the server's English for every refusal, the session cap's too.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { URNetworkApiError, type URNetworkApiClient } from "@urnetwork/sdk/client";
import {
	defaultOwnSignInSettings,
	redeemOwnSignInCode,
	revokeSession,
} from "../src/utils/own-sign-in";
import {
	codeSignInFailure,
	codeSignInFailureText,
	requestCodeSignIn,
} from "../src/utils/code-sign-in";
import { installChromeMock, message } from "./chrome-mock";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function apiError(kind: "network" | "timeout" | "http", status = 0, body?: unknown): URNetworkApiError {
	return new URNetworkApiError({
		kind,
		status,
		body,
		message: `${kind} ${status}`,
		operationId: "authCodeLogin",
		method: "POST",
		url: "https://api.example/auth/code-login",
	});
}

// a client whose code-login answers each call in turn
function codeLoginClient(...answers: Array<unknown | Error>) {
	const authCodeLogin = vi.fn(async () => {
		const answer = answers.shift();
		if (answer instanceof Error) throw answer;
		return answer;
	});
	return { client: { authCodeLogin } as unknown as URNetworkApiClient, authCodeLogin };
}

describe("redeeming a sign-in code", () => {
	it("sends a redemption whose answer was lost once more, with the same code and request id", async () => {
		const { client, authCodeLogin } = codeLoginClient(apiError("network"), { by_jwt: "synthetic.token.sig" });

		const redemption = await redeemOwnSignInCode(client, "synthetic-code");

		expect(redemption).toEqual({ kind: "signed_in", byJwt: "synthetic.token.sig" });
		expect(authCodeLogin).toHaveBeenCalledTimes(2);
		const [first, second] = authCodeLogin.mock.calls.map((call) => (call as unknown[])[0]);
		expect(first).toEqual({ auth_code: "synthetic-code", request_id: expect.stringMatching(UUID) });
		expect(second).toEqual(first);
	});

	it("resends after a timeout or a server error, never after a refusal", async () => {
		for (const lost of [apiError("timeout"), apiError("http", 503)]) {
			const { client, authCodeLogin } = codeLoginClient(lost, { by_jwt: "synthetic.token.sig" });
			expect(await redeemOwnSignInCode(client, "synthetic-code")).toMatchObject({ kind: "signed_in" });
			expect(authCodeLogin).toHaveBeenCalledTimes(2);
		}
		// a 4xx is the same on a resend
		const refusal = codeLoginClient(apiError("http", 400, { error: "invalid_request" }));
		await expect(redeemOwnSignInCode(refusal.client, "synthetic-code")).rejects.toThrow();
		expect(refusal.authCodeLogin).toHaveBeenCalledTimes(1);
		// the session cap is an answer, not a failure
		const capped = codeLoginClient(apiError("http", 409, { code: "session_limit_reached", error: "capped" }));
		expect(await redeemOwnSignInCode(capped.client, "synthetic-code")).toEqual({ kind: "session_limit_reached" });
		expect(capped.authCodeLogin).toHaveBeenCalledTimes(1);
		// a refused code too
		const refused = codeLoginClient({ by_jwt: "", error: { message: "Invalid auth code." } });
		expect(await redeemOwnSignInCode(refused.client, "synthetic-code")).toEqual({ kind: "refused" });
		expect(refused.authCodeLogin).toHaveBeenCalledTimes(1);
	});

	it("sends it once more only, and not at all with no resends set", async () => {
		const twice = codeLoginClient(apiError("network"), apiError("network"), { by_jwt: "late" });
		await expect(redeemOwnSignInCode(twice.client, "synthetic-code")).rejects.toThrow("network");
		expect(twice.authCodeLogin).toHaveBeenCalledTimes(2);

		const once = codeLoginClient(apiError("network"), { by_jwt: "late" });
		const settings = { ...defaultOwnSignInSettings(), redeemRetries: 0 };
		await expect(redeemOwnSignInCode(once.client, "synthetic-code", settings)).rejects.toThrow("network");
		expect(once.authCodeLogin).toHaveBeenCalledTimes(1);
	});

	it("names each redemption by its own request id", async () => {
		const { client, authCodeLogin } = codeLoginClient({ by_jwt: "a.b.c" }, { by_jwt: "d.e.f" });
		await redeemOwnSignInCode(client, "synthetic-code-1");
		await redeemOwnSignInCode(client, "synthetic-code-2");
		const ids = authCodeLogin.mock.calls.map((call) => ((call as unknown[])[0] as { request_id: string }).request_id);
		expect(ids[0]).not.toBe(ids[1]);
	});
});

describe("signing a session out on the server", () => {
	it("sends the session and an operation id with the session's own token, bounded to 2 seconds", async () => {
		const networkRevokeSession = vi.fn(async () => ({ operation_id: "op", status: "revoked" }));
		const client = { networkRevokeSession } as unknown as URNetworkApiClient;

		await revokeSession(client, "synthetic.own.token", "synthetic-session");

		expect(networkRevokeSession).toHaveBeenCalledWith(
			{},
			{ session_id: "synthetic-session", operation_id: expect.stringMatching(UUID) },
			{ token: "synthetic.own.token", timeoutMs: 2_000 },
		);
	});

	it("never rejects: the local sign-out goes on", async () => {
		const client = {
			networkRevokeSession: vi.fn(async () => {
				throw apiError("timeout");
			}),
		} as unknown as URNetworkApiClient;

		await expect(revokeSession(client, "synthetic.own.token", "synthetic-session")).resolves.toBeUndefined();
	});
});

describe("the popup's code sign-in", () => {
	beforeEach(() => {
		installChromeMock();
	});

	it("asks the background, which redeems the code, and reads its answer", async () => {
		const sent: unknown[] = [];
		const answer = await requestCodeSignIn("synthetic-code", async (msg) => {
			sent.push(msg);
			return { success: true, jwt: "a.b.c", networkName: "testnet" };
		});

		expect(sent).toEqual([{ type: "POPUP_CODE_SIGN_IN", authCode: "synthetic-code" }]);
		expect(answer).toEqual({ success: true, jwt: "a.b.c", networkName: "testnet" });
		expect(await requestCodeSignIn("x", async () => ({ success: false, code: "session_limit_reached" }))).toEqual({
			success: false,
			code: "session_limit_reached",
		});
		// a background that does not answer is a failure, never a rejection
		expect(
			await requestCodeSignIn("x", async () => {
				throw new Error("Could not establish connection.");
			}),
		).toEqual({ success: false });
	});

	it("says the session cap's refusal in the store's words, and marks a refused code on its input", () => {
		expect(codeSignInFailure("session_limit_reached")).toBe("session_limit_reached");
		expect(codeSignInFailure("auth_code_refused")).toBe("refused");
		expect(codeSignInFailure(undefined)).toBe("failed");

		// the line sends the user to a device that is signed in
		expect(codeSignInFailureText("session_limit_reached")).toBe(message("sessions_limit_reached_sign_in"));
		expect(codeSignInFailureText("session_limit_reached")).toMatch(/Account > Sessions/);
		expect(codeSignInFailureText("failed")).toBe(message("something_went_wrong"));
		// a refused code: the input says it (auth_code_input_invalid), no line
		expect(codeSignInFailureText("refused")).toBeNull();
		expect(codeSignInFailureText(null)).toBeNull();
	});
});
