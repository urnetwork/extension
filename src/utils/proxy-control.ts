// Who holds the browser's proxy setting. On Chromium the setting is the
// extension's only while the browser says so (chrome.proxy.settings
// levelOfControl): another extension can hold it with priority (the one
// installed last wins), and policy can fix it. The extension never applies its
// proxy over either (utils/proxy-manager.ts), and the popup says which holds it
// (utils/connection-manager.ts). Its own module so the popup reads the types
// without loading the background's proxy manager.

// - ours: this extension's value is the one in effect;
// - available: this extension can set it (nothing holds it, or an extension
//   that yields to this one does);
// - other_extension: another extension holds it, with priority over this one;
// - policy: policy (or the command line) fixes it, and no extension can set it.
// Firefox answers per request (proxy.onRequest), so there it is ours while the
// listener is in place, and available otherwise.
export type ProxyControl = "ours" | "available" | "other_extension" | "policy";

// the two that keep this extension from connecting
export type ProxyControlRefusal = "other_extension" | "policy";

export function isControlRefusal(control: ProxyControl): control is ProxyControlRefusal {
	return control === "other_extension" || control === "policy";
}

export function controlOf(levelOfControl: unknown): ProxyControl {
	switch (levelOfControl) {
		case "controlled_by_this_extension":
			return "ours";
		case "controlled_by_other_extensions":
			return "other_extension";
		case "not_controllable":
			return "policy";
		default:
			return "available";
	}
}

// The connect refusal for each, as the bridge (ur.io) and the popup get it. The
// popup shows its own translated text for the code.
export const PROXY_CONTROL_REFUSALS: Record<ProxyControlRefusal, { code: string; message: string }> = {
	other_extension: {
		code: "proxy_other_extension",
		message: "Another extension controls this browser's proxy settings, so URnetwork can't connect.",
	},
	policy: {
		code: "proxy_policy",
		message: "This browser's proxy settings are managed by policy, so URnetwork can't connect.",
	},
};

/** The control a refusal code stands for, if it is one. */
export function refusalOfCode(code: unknown): ProxyControlRefusal | null {
	for (const [control, refusal] of Object.entries(PROXY_CONTROL_REFUSALS)) {
		if (refusal.code === code) return control as ProxyControlRefusal;
	}
	return null;
}

/** The browser keeps its proxy setting from this extension. */
export class ProxyControlError extends Error {
	readonly control: ProxyControlRefusal;
	readonly code: string;

	constructor(control: ProxyControlRefusal) {
		super(PROXY_CONTROL_REFUSALS[control].message);
		this.name = "ProxyControlError";
		this.control = control;
		this.code = PROXY_CONTROL_REFUSALS[control].code;
	}
}

// What the browser has in effect: who holds it, and its mode ("system" when
// nothing does).
export type ProxySettingReading = {
	control: ProxyControl;
	mode: string | undefined;
};

// The proxy as the popup shows it (background/index.ts GET_VPN_STATE): whether
// the browser sends through this extension's proxy, who holds the setting, and
// whether the extension means to be connected (its saved proxy_enabled), which
// is what a Disconnect ends when another extension holds the setting over it.
export type ProxyView = {
	enabled: boolean;
	control: ProxyControl;
	intent: boolean;
};
