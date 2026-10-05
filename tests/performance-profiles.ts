// The connect options as ur.io builds them (mmm
// ur.io/react/src/app/connect/performanceProfile.js, the native apps' table):
// Auto has no window size; Web ("quality") and Streaming ("speed") size the
// window 1..1 with Fixed IP and 2..4 without. Shared by the tests that check
// they reach the auth-client wire.
export const AUTO = {
	windowType: "auto",
	windowSize: null,
	allowDirect: false,
	postQuantumEncryption: false,
};
export const FIXED_IP_WEB = { ...AUTO, windowType: "quality", windowSize: { windowSizeMin: 1, windowSizeMax: 1 } };
export const FIXED_IP_STREAMING = { ...FIXED_IP_WEB, windowType: "speed" };
export const WEB = { ...AUTO, windowType: "quality", windowSize: { windowSizeMin: 2, windowSizeMax: 4 } };
export const STREAMING = { ...WEB, windowType: "speed" };

// the wire window (sdk WindowSizeSettings): the fields ur.io leaves out are
// the sdk's 0 defaults
export function wireWindow(min: number, max: number) {
	return {
		window_size_min: min,
		window_size_min_p2p_only: 0,
		window_size_max: max,
		window_size_hard_max: 0,
		window_size_reconnect_scale: 0,
		keep_healthiest_count: 0,
		ulimit: 0,
	};
}

// the wire profile for `windowType` and `windowSize`, with both flags off
export function wireProfile(windowType: string, windowSize: ReturnType<typeof wireWindow> | null) {
	return {
		window_type: windowType,
		window_size: windowSize,
		allow_direct: false,
		post_quantum_encryption: false,
	};
}
