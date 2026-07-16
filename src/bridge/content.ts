// App content-channel bridge (page side).
//
// Injected on ur.io / app.ur.network. Relays window.postMessage requests from
// the page to the background bridge service over a long-lived Port, relays
// responses and events back, and announces itself so the page can detect that
// the channel is mounted. This is the only page↔extension channel that works
// uniformly on Chrome, Edge, Brave AND Firefox (Firefox does not support
// externally_connectable messaging from web pages). Frame shapes and the port
// name are defined in protocol.ts.
import {
	BRIDGE_PORT_NAME,
	EXTENSION_SENDER,
	PAGE_FRAME_MARKER,
	type PageRequestFrame,
} from "./protocol";

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10_000;

let port: chrome.runtime.Port | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let closed = false;

// request ids in flight, so a dropped port can fail them fast
const pending = new Set<string | number>();

function extensionVersion(): string {
	try {
		return chrome.runtime.getManifest().version;
	} catch {
		return "";
	}
}

function post(message: Record<string, unknown>): void {
	try {
		window.postMessage(
			{ urnb: PAGE_FRAME_MARKER, from: EXTENSION_SENDER, ...message },
			window.location.origin,
		);
	} catch {
		// page gone
	}
}

function announce(): void {
	post({ dir: "hello", version: extensionVersion() });
}

function failPending(): void {
	for (const id of pending) {
		post({ dir: "res", id, ok: false, error: "disconnected", code: "disconnected" });
	}
	pending.clear();
}

function connectPort(): chrome.runtime.Port | null {
	if (closed) return null;
	if (port) return port;
	try {
		port = chrome.runtime.connect({ name: BRIDGE_PORT_NAME });
	} catch {
		// extension reloaded/uninstalled — this content script instance is orphaned
		closed = true;
		return null;
	}

	port.onMessage.addListener((msg: Record<string, unknown>) => {
		if (!msg || typeof msg !== "object") return;
		if (msg.dir === "res") {
			pending.delete(msg.id as string | number);
		}
		post(msg);
	});

	port.onDisconnect.addListener(() => {
		port = null;
		failPending();
		if (chrome.runtime?.lastError || !chrome.runtime?.id) {
			// invalidated context: stop trying
			closed = true;
			return;
		}
		// The MV3 service worker idles out and drops ports; reconnect with
		// backoff so events keep flowing while the page is open.
		setTimeout(() => {
			const p = connectPort();
			if (p) {
				reconnectDelay = RECONNECT_MIN_MS;
				announce();
			} else if (!closed) {
				reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
			}
		}, reconnectDelay);
	});

	return port;
}

window.addEventListener("message", (event: MessageEvent) => {
	// only same-window, same-origin page messages
	if (event.source !== window) return;
	if (event.origin !== window.location.origin) return;
	const data = event.data as PageRequestFrame | null;
	if (!data || data.urnb !== PAGE_FRAME_MARKER || data.dir !== "req") return;
	if (data.from === EXTENSION_SENDER) return; // ignore our own posts
	const { id, verb, payload } = data;
	if (id == null || typeof verb !== "string") return;

	if (verb === "PING") {
		post({ dir: "res", id, ok: true, data: { version: extensionVersion() } });
		return;
	}

	const p = connectPort();
	if (!p) {
		post({ dir: "res", id, ok: false, error: "unavailable", code: "unavailable" });
		return;
	}

	pending.add(id);
	try {
		p.postMessage({ id, verb, payload });
	} catch {
		pending.delete(id);
		post({ dir: "res", id, ok: false, error: "disconnected", code: "disconnected" });
	}
});

// mount marker (usable before any messaging) + initial hello
try {
	document.documentElement.dataset.urnetworkExtension = extensionVersion();
} catch {
	// documentElement not ready — hello still announces
}
connectPort();
announce();
