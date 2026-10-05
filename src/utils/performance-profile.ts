// Connect options: the performance profile every session starts with.
//
// ur.io owns the options (mode, Fixed IP, Strong Anonymization, post quantum
// encryption). Its Connect screen keeps them in its settings doc and builds
// the profile exactly as the native apps do (mmm
// ur.io/react/src/app/connect/performanceProfile.js): Auto has no window size,
// and Web ("quality") and Streaming ("speed") size the window 1..1 with Fixed
// IP and 2..4 without. The page hands the extension that profile over the app
// bridge (CONNECT and SET_PERFORMANCE_PROFILE, see bridge/background.ts) in
// the camelCase shape its DeviceRemote takes. The extension keeps the last one
// per network and provisions every session with it
// (initial_device_state.performance_profile): bridge connects and renewals,
// and the popup's connects, which no ur.io tab attaches to. The server keeps
// a session's initial device state, so a hosted device recreated while no tab
// is open (idle reap, egress death, proxy host restart) starts with it again.
//
// The extension builds nothing here: it only checks the page's profile and
// renames it to the wire shape (sdk/js/src/generated/types.ts).
import { parseJwtClaims } from "./jwt-claims";
import type { PerformanceProfile } from "./sdk-types";

const STORAGE_KEY = "connect_performance_profile";

// What STORAGE_KEY holds: the last profile ur.io handed over, and the network
// it belongs to.
type StoredPerformanceProfile = {
	networkId: string;
	performanceProfile: PerformanceProfile | null;
};

const WINDOW_TYPES = new Set(["auto", "quality", "speed"]);

// the window size settings, page name -> wire name
const WINDOW_SIZE_INTEGERS = [
	["windowSizeMin", "window_size_min"],
	["windowSizeMinP2pOnly", "window_size_min_p2p_only"],
	["windowSizeMax", "window_size_max"],
	["windowSizeHardMax", "window_size_hard_max"],
	["keepHealthiestCount", "keep_healthiest_count"],
	["ulimit", "ulimit"],
] as const;

// The error every refused profile throws.
function invalid(): Error {
	return new Error("Invalid performance profile");
}

// Whether `value` is a plain object (not null, not an array).
function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A field the sdk leaves at 0 for its default.
function windowSizeInteger(windowSize: Record<string, unknown>, key: string): number {
	const value = windowSize[key] ?? 0;
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
	return value as number;
}

// The wire window size settings for the page's window size, or null for none.
// Throws on a setting the sdk would not take.
function wireWindowSize(value: unknown): NonNullable<PerformanceProfile["window_size"]> | null {
	if (value == null) return null;
	if (!isObject(value)) throw invalid();
	const integers = Object.fromEntries(
		WINDOW_SIZE_INTEGERS.map(([key, wireKey]) => [wireKey, windowSizeInteger(value, key)]),
	) as Record<(typeof WINDOW_SIZE_INTEGERS)[number][1], number>;
	const reconnectScale = value.windowSizeReconnectScale ?? 0;
	if (typeof reconnectScale !== "number" || !Number.isFinite(reconnectScale) || reconnectScale < 0) {
		throw invalid();
	}
	// the multi client refuses a window whose max is below its min
	if (integers.window_size_max < integers.window_size_min) throw invalid();
	return { ...integers, window_size_reconnect_scale: reconnectScale };
}

/**
 * The wire profile for a profile the page sent: null for null (the sdk's
 * auto). Throws on anything the page's builder does not make (an unknown
 * mode, a flag that is not a boolean, a window the multi client would refuse),
 * so a bad request changes nothing. Auto carries no window size.
 */
export function parsePerformanceProfile(value: unknown): PerformanceProfile | null {
	if (value === null) return null;
	if (!isObject(value)) throw invalid();
	const { windowType, windowSize, allowDirect, postQuantumEncryption } = value;
	if (typeof windowType !== "string" || !WINDOW_TYPES.has(windowType)) throw invalid();
	if (typeof allowDirect !== "boolean" || typeof postQuantumEncryption !== "boolean") {
		throw invalid();
	}
	const wireSize = wireWindowSize(windowSize);
	return {
		window_type: windowType,
		window_size: windowType === "auto" ? null : wireSize,
		allow_direct: allowDirect,
		post_quantum_encryption: postQuantumEncryption,
	};
}

// The network the stored identity (by_jwt) belongs to.
function storedNetworkId(byJwt: unknown): string | null {
	if (typeof byJwt !== "string" || !byJwt) return null;
	const networkId = parseJwtClaims(byJwt)?.network_id;
	return typeof networkId === "string" && networkId ? networkId : null;
}

/**
 * Keep `performanceProfile` as the connect options of the stored identity's
 * network. Returns false, keeping nothing, when the extension holds no
 * identity.
 */
export async function storePerformanceProfile(
	performanceProfile: PerformanceProfile | null,
): Promise<boolean> {
	const result = await chrome.storage.local.get("by_jwt");
	const networkId = storedNetworkId(result.by_jwt);
	if (!networkId) return false;
	const stored: StoredPerformanceProfile = { networkId, performanceProfile };
	await chrome.storage.local.set({ [STORAGE_KEY]: stored });
	return true;
}

/**
 * The connect options to provision with: the profile ur.io last handed over
 * for the stored identity's network, else null (the sdk's auto). A profile
 * kept for another network is never used.
 */
export async function loadPerformanceProfile(): Promise<PerformanceProfile | null> {
	const result = await chrome.storage.local.get(["by_jwt", STORAGE_KEY]);
	const networkId = storedNetworkId(result.by_jwt);
	const stored = result[STORAGE_KEY];
	if (!networkId || !isObject(stored) || stored.networkId !== networkId) return null;
	const performanceProfile = (stored as StoredPerformanceProfile).performanceProfile;
	return isObject(performanceProfile) ? performanceProfile : null;
}
