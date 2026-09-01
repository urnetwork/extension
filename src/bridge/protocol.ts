// Wire protocol for the app content-channel bridge, shared by the page-side
// relay (content.ts) and the background service (background.ts) so the two
// bundles cannot drift.
//
// Page ↔ content script (window.postMessage): every frame carries
// { urnb: PAGE_FRAME_MARKER }, and frames posted by the extension also carry
// { from: EXTENSION_SENDER } so the relay can ignore its own posts.
//   page → extension:  { urnb, dir: "req",   id, verb, payload }
//   extension → page:  { urnb, dir: "res",   id, ok, data?, error?, code? }
//                      { urnb, dir: "event", event, payload }
//                      { urnb, dir: "hello", version }
//
// Content script ↔ background (long-lived Port named BRIDGE_PORT_NAME):
//   relay → service:   { id, verb, payload }
//   service → relay:   { dir: "res", id, ok, data?, error?, code? }
//                      { dir: "event", event, payload }
//
// The relay forwards service frames to the page unchanged apart from adding
// the page markers. The verbs and events themselves are documented in
// background.ts.
//
// Opaque SDK traffic uses DEVICE_RPC_PORT_NAME and dir:"device-rpc" frames.
// OPEN carries only {connectionId, instanceId}; endpoints and credentials are
// resolved inside the background service and never exist on the page channel.

export const BRIDGE_PORT_NAME = "urnetwork-app-bridge";

// Dedicated high-volume channel for opaque SDK device-rpc frames. Keeping it
// separate from BRIDGE_PORT_NAME prevents control responses/events from being
// queued behind binary traffic and lets either channel reconnect independently.
export const DEVICE_RPC_PORT_NAME = "urnetwork-device-rpc-v1";

// Marker field value on every page-hop frame ({ urnb: PAGE_FRAME_MARKER }).
export const PAGE_FRAME_MARKER = 1;

// `from` tag on extension → page frames.
export const EXTENSION_SENDER = "urnetwork-extension";

// A page → relay request as received from window.postMessage (untrusted, so
// everything is loose until validated).
export type PageRequestFrame = {
	urnb?: unknown;
	dir?: unknown;
	from?: unknown;
	id?: string | number;
	verb?: unknown;
	payload?: unknown;
};

// A relay → service request as received on the Port (untrusted, so everything
// is loose until validated).
export type PortRequestFrame = {
	id?: unknown;
	verb?: unknown;
	payload?: unknown;
};

export const DEVICE_RPC_FRAME_MAX_BYTES = 3 * 1024 * 1024;
export const DEVICE_RPC_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
export const DEVICE_RPC_QUEUE_MAX_FRAMES = 64;

export type DeviceRpcPageFrame = {
	urnb?: unknown;
	dir?: unknown;
	from?: unknown;
	kind?: unknown;
	connectionId?: unknown;
	instanceId?: unknown;
	sequence?: unknown;
	data?: unknown;
	byteLength?: unknown;
};
