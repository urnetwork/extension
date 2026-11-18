// The popup's sign-in with a code: its code entry, and SSO, whose page hands
// back a code. The background redeems the code for a sign-in of the
// extension's own (bridge/background.ts signInWithCode, utils/own-sign-in.ts),
// so the request id and the stored identity live there and a popup that closes
// mid-way loses nothing; it answers how it went, and the popup says a refusal
// in the store's words.
import { SESSION_LIMIT_REACHED_CODE } from "@urnetwork/sdk/client";
import { getMessage } from "./i18n";
import { AUTH_CODE_REFUSED, POPUP_CODE_SIGN_IN, SIGNED_OUT } from "./own-sign-in";

/** The background's answer to POPUP_CODE_SIGN_IN. */
export type CodeSignInAnswer =
	| { success: true; jwt: string; networkName?: string }
	| { success: false; code?: string; error?: string };

/**
 * Why a code sign-in did not sign in: the code was refused (expired, used,
 * not a code), the account holds its cap of active sessions, or anything else
 * (no answer).
 */
export type CodeSignInFailure = "refused" | "session_limit_reached" | "failed";

type SendMessage = (message: Record<string, unknown>) => Promise<unknown>;

/** Asks the background to sign in with `authCode`. Never rejects. */
export async function requestCodeSignIn(
	authCode: string,
	send: SendMessage = (message) => chrome.runtime.sendMessage(message),
): Promise<CodeSignInAnswer> {
	try {
		const answer = (await send({ type: POPUP_CODE_SIGN_IN, authCode })) as Record<string, unknown> | null;
		if (answer?.success === true && typeof answer.jwt === "string" && answer.jwt) {
			return {
				success: true,
				jwt: answer.jwt,
				networkName: typeof answer.networkName === "string" ? answer.networkName : undefined,
			};
		}
		return { success: false, code: typeof answer?.code === "string" ? answer.code : undefined };
	} catch {
		// the background did not answer
		return { success: false };
	}
}

/** A refusal's code (the background's answer, or SSO's) as the popup words it. */
export function codeSignInFailure(code: unknown): CodeSignInFailure {
	if (code === SESSION_LIMIT_REACHED_CODE) return "session_limit_reached";
	if (code === AUTH_CODE_REFUSED) return "refused";
	return "failed";
}

/**
 * The line a failure shows under the form. None for a refused code, which the
 * input marks with auth_code_input_invalid. The session cap's line sends the
 * user to a device that is signed in: this one is not.
 */
export function codeSignInFailureText(failure: CodeSignInFailure | null): string | null {
	switch (failure) {
		case "session_limit_reached":
			return getMessage("sessions_limit_reached_sign_in");
		case "failed":
			return getMessage("something_went_wrong");
		default:
			return null;
	}
}

/**
 * Calls `listener` when the background signs the extension out on its own (a
 * renewal the server rejected); returns the unsubscribe.
 */
export function onSignedOut(listener: () => void): () => void {
	const onMessage = (message: unknown) => {
		if ((message as { type?: unknown } | null)?.type === SIGNED_OUT) listener();
	};
	chrome.runtime.onMessage.addListener(onMessage);
	return () => chrome.runtime.onMessage.removeListener(onMessage);
}
