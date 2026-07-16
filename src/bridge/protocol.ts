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

export const BRIDGE_PORT_NAME = "urnetwork-app-bridge";

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
