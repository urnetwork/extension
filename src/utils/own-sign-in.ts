// The extension's own sign-in (owner decision 2026-11-18). The extension signs
// in with a session of its own: the account's Sessions list shows it apart (as
// the browser extension, from its client info: device type web with an
// extension distribution, utils/client-info.ts) and signs it out on its own,
// and a sign-out on ur.io leaves it signed in. It gets one by redeeming a
// one-use sign-in code (POST /auth/code-login, which the server makes an
// independent session of): a code ur.io creates with its own sign-in for
// SETUP (bridge/background.ts), one the user types into the popup, or the one
// SSO hands back. Before, ur.io handed it the page's own token, so the two
// shared one session and the page's sign-out signed the extension out.
//
// Owning its session, the extension (bridge/background.ts):
// - renews its token itself (POST /auth/network-refresh), on an alarm at the
//   point of the token's lifetime the sdk renews at; no page pushes it one;
// - signs itself out locally when a renewal is rejected: the server ended the
//   sign-in (revoked in Sessions, signed out, expired);
// - signs its session out on the server when it ends its sign-in on purpose
//   (its popup's sign-out, a setup that replaces it), best effort and
//   bounded, so a signed-out extension does not stay listed as a live session.
//
// Only the session the extension signed in itself is revoked
// (STORAGE_KEY_OWN_SESSION_ID): a token a page handed over (an older page's
// SETUP {jwt}, or an older version's external SET_JWT, removed 2026-11-18) is
// the page's own session, and revoking it would sign the page out too.
//
// An install from before holds such a token, ur.io's, and shares ur.io's
// session. It moves to a session of its own by itself (owner decision
// 2026-11-18, "Migrate automatically"; bridge/background.ts
// migrateToOwnSignIn): a sign-in code created with the token it holds,
// redeemed and checked as SETUP's code is (migrateOwnSignIn), and only then the
// switch. ur.io's session is left alone, never signed out.
import {
	createSignInCode,
	isURNetworkApiError,
	redeemSignInCode,
	SESSION_LIMIT_REACHED_CODE,
	type SignInCodeRedemption,
	type URNetworkApiClient,
} from "@urnetwork/sdk/client";
import { parseJwtClaims } from "./jwt-claims";

export type OwnSignInSettings = {
	// resends of a redemption whose answer was lost (no answer, a server
	// error), with the same code and request id, so the server answers with
	// the sign-in it made; non-positive sends it once
	redeemRetries: number;
	// ms before a renewal that failed (no answer, a server error) is tried
	// again; the token stays valid meanwhile
	renewRetryMs: number;
	// ms a sign-out waits for the server to sign the session out before the
	// local sign-out goes on without it
	revokeTimeoutMs: number;
	// ms from a migration to a session of the extension's own that did not
	// happen to the next try, by the failures so far: the nth failure waits
	// the nth entry, and the last entry repeats
	migrationRetryMs: number[];
};

export function defaultOwnSignInSettings(): OwnSignInSettings {
	return {
		// a lost answer is rare, and a resend is free: the server keeps the
		// sign-in it made under the request id
		redeemRetries: 1,
		// a renewal starts at 40-50% of the token's 30-day lifetime, so a retry
		// every 15 minutes has about two weeks before the token expires
		renewRetryMs: 15 * 60 * 1000,
		// a sign-out is the user's, and the server's part is best effort
		revokeTimeoutMs: 2_000,
		// at most a few tries a day (owner, 2026-11-18): 4 in the first day,
		// then 3; the old sign-in works on meanwhile
		migrationRetryMs: [2 * HOUR_MS, 8 * HOUR_MS],
	};
}

const HOUR_MS = 60 * 60 * 1000;

// The session_id of the sign-in the extension made itself (its token's claim),
// or UNTAGGED_OWN_SESSION for one without (ownSessionMark).
export const STORAGE_KEY_OWN_SESSION_ID = "own_session_id";

// The own-session mark of a sign-in the extension made itself whose token has
// no session_id (a server without sessions): such a sign-in is the
// extension's own all the same, and is not migrated again.
export const UNTAGGED_OWN_SESSION = "untagged";

// The migration to a session of the extension's own: its state while a try
// is to come ({failures, nextAttemptAt}, epoch ms), and the alarm of the next
// try. Durable state in the user's browser: a rename strands what is set.
export const STORAGE_KEY_OWN_SIGN_IN_MIGRATION = "own_sign_in_migration";
export const OWN_SIGN_IN_MIGRATION_ALARM = "urn-own-sign-in-migrate";

export type OwnSignInMigrationState = {
	// the tries that did not happen so far, the one under way included
	failures: number;
	// no try before this
	nextAttemptAt: number;
};

// The renewal alarm of the extension's own sign-in. Durable state in the
// user's browser: a rename strands the alarms already set.
export const OWN_SESSION_RENEW_ALARM = "urn-own-session-renew";

// The codes a sign-in with a code that did not happen answers with (SETUP's
// error frame, the popup's answer), beside the sdk's SESSION_LIMIT_REACHED_CODE
// (the account holds its cap of active sessions). The page branches on them.
// expired, used already, or not a code: a fresh code may work
export const AUTH_CODE_REFUSED = "auth_code_refused";
// the sign-in is of another network than the page's
export const WRONG_NETWORK = "wrong_network";

// The popup's request to sign in with a code, and the background's notice
// that it signed the extension out (background/index.ts, utils/code-sign-in.ts).
export const POPUP_CODE_SIGN_IN = "POPUP_CODE_SIGN_IN";
export const SIGNED_OUT = "SIGNED_OUT";

function codedError(message: string, code: string): Error & { code: string } {
	const error = new Error(message) as Error & { code: string };
	error.code = code;
	return error;
}

/**
 * The token's session_id claim, the session the account's Sessions list
 * shows: null for a token from before sessions were tagged, which cannot be
 * signed out by id.
 */
export function sessionIdOf(byJwt: string): string | null {
	const sessionId = parseJwtClaims(byJwt)?.session_id;
	return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
}

/** What STORAGE_KEY_OWN_SESSION_ID holds for a sign-in of the extension's own. */
export function ownSessionMark(byJwt: string): string {
	return sessionIdOf(byJwt) ?? UNTAGGED_OWN_SESSION;
}

/** The wait before the next migration try after `failures` tries that did not happen. */
export function migrationRetryDelayMs(
	failures: number,
	settings: OwnSignInSettings = defaultOwnSignInSettings(),
): number {
	const delays = settings.migrationRetryMs;
	return delays[Math.min(Math.max(failures, 1), delays.length) - 1];
}

/**
 * Whether a stored state's next migration try is due at `nowMs`: no state
 * (no try yet), or its time has come.
 */
export function migrationDue(state: OwnSignInMigrationState | null, nowMs: number): boolean {
	return !state || state.nextAttemptAt <= nowMs;
}

// Whether a redemption that rejected may have reached the server and lost its
// answer: no answer, an unreadable one, or a server error. A refusal (another
// 4xx) is the same on a resend.
function answerLost(error: unknown): boolean {
	if (!isURNetworkApiError(error) || error.kind !== "http") return true;
	return 500 <= error.status;
}

/**
 * Redeems a sign-in code under one request id: a redemption whose answer was
 * lost is sent again with the same code and id, at most
 * `settings.redeemRetries` times, and the server answers with the sign-in it
 * made. Rejects when no answer came back.
 */
export async function redeemOwnSignInCode(
	client: URNetworkApiClient,
	authCode: string,
	settings: OwnSignInSettings = defaultOwnSignInSettings(),
): Promise<SignInCodeRedemption> {
	const requestId = crypto.randomUUID();
	for (let attempt = 0; ; attempt++) {
		try {
			return await redeemSignInCode(client, authCode, requestId);
		} catch (error) {
			if (settings.redeemRetries <= attempt || !answerLost(error)) throw error;
		}
	}
}

/**
 * Signs a session out on the server with its own token (POST
 * /network/revoke-session), best effort: waits at most
 * `settings.revokeTimeoutMs` and never rejects. A sign-out that does not reach
 * the server leaves the session listed until it expires.
 */
export async function revokeSession(
	client: URNetworkApiClient,
	byJwt: string,
	sessionId: string,
	settings: OwnSignInSettings = defaultOwnSignInSettings(),
): Promise<void> {
	try {
		await client.networkRevokeSession(
			{},
			{ session_id: sessionId, operation_id: crypto.randomUUID() },
			{ token: byJwt, timeoutMs: settings.revokeTimeoutMs },
		);
	} catch {
		// best effort: the local sign-out goes on
	}
}

/**
 * A sign-in of the extension's own from a code: the redeemed token, checked.
 * Rejects with an Error whose `code` the bridge answers with:
 * AUTH_CODE_REFUSED, SESSION_LIMIT_REACHED_CODE, or WRONG_NETWORK for a
 * sign-in of another network than `networkId` (undefined takes any). A guest's
 * sign-in, and a redemption that got no answer, reject without one. A sign-in
 * redeemed and then refused here is signed out on the server, so the list
 * does not keep a session nothing uses.
 */
export async function redeemOwnSignIn(
	client: URNetworkApiClient,
	authCode: string,
	networkId: string | undefined,
	settings: OwnSignInSettings = defaultOwnSignInSettings(),
): Promise<string> {
	const redemption = await redeemOwnSignInCode(client, authCode, settings);
	if (redemption.kind === "refused") {
		throw codedError(
			"The sign-in code was refused. It may have expired or been used already.",
			AUTH_CODE_REFUSED,
		);
	}
	if (redemption.kind === "session_limit_reached") {
		throw codedError("The account has too many active sessions.", SESSION_LIMIT_REACHED_CODE);
	}
	const byJwt = redemption.byJwt;
	const claims = parseJwtClaims(byJwt);
	let refusal: Error | null = null;
	if (!claims) {
		refusal = new Error("Invalid token");
	} else if (claims.guest_mode) {
		// the web app has no guest entry point by design; refused defensively
		refusal = new Error("Guest sessions cannot set up the extension.");
	} else if (networkId !== undefined && claims.network_id !== networkId) {
		refusal = codedError("The sign-in is for another network.", WRONG_NETWORK);
	}
	if (refusal) {
		const sessionId = sessionIdOf(byJwt);
		if (sessionId) {
			await revokeSession(client, byJwt, sessionId, settings);
		}
		throw refusal;
	}
	return byJwt;
}

/**
 * A sign-in of the extension's own in place of a token of another session it
 * holds (ur.io's): a one-use sign-in code created with that token (the sdk's
 * createSignInCode, POST /auth/code-create with it as the bearer), redeemed
 * and checked as SETUP's code is (redeemOwnSignIn), of the token's network.
 * Nothing signs the held token's session out. Rejects, the held token as good
 * as it was, when the server refused the code (AUTH_CODE_REFUSED, also for
 * the account's most codes), when the held token ended (401), the session cap
 * (SESSION_LIMIT_REACHED_CODE), another network's sign-in (WRONG_NETWORK,
 * which is signed out unused), or no answer.
 */
export async function migrateOwnSignIn(
	client: URNetworkApiClient,
	heldJwt: string,
	settings: OwnSignInSettings = defaultOwnSignInSettings(),
): Promise<string> {
	const networkId = parseJwtClaims(heldJwt)?.network_id;
	if (typeof networkId !== "string" || networkId === "") {
		throw new Error("The sign-in held names no network.");
	}
	const creation = await createSignInCode(client, { token: heldJwt });
	if (creation.kind !== "created") {
		throw codedError(creation.message || "The sign-in code was not created.", AUTH_CODE_REFUSED);
	}
	return redeemOwnSignIn(client, creation.authCode, networkId, settings);
}

/** A draw in [0, 1) for networkTokenRenewalTime, from the browser's cryptographic source. */
export function renewalDraw(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}
