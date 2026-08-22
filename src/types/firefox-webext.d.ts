/**
 * The Firefox-only WebExtensions surface this extension actually touches.
 *
 * `@types/chrome` is the only extension typing installed, and it declares
 * `chrome` alone -- nothing in the dependency tree declares Firefox's `browser`
 * global. These declarations fill that gap.
 *
 * Only the members this codebase calls are declared; nothing is asserted about
 * the rest of the namespace. Every member is optional because Chrome does not
 * define `browser` at all and Firefox's request-level proxy API is
 * version-dependent, so every call site feature-detects before using it.
 */

/** One proxy entry returned from a `proxy.onRequest` listener. */
export type FirefoxProxyInfo = {
	type: "http" | "https" | "socks" | "socks4" | "direct";
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	failoverTimeout?: number;
};

/** The request being proxied. Only `url` is read here. */
export type FirefoxProxyDetails = {
	url: string;
};

export type FirefoxProxyRequestListener = (
	details: FirefoxProxyDetails,
) => FirefoxProxyInfo[];

export interface FirefoxProxyOnRequestEvent {
	addListener(listener: FirefoxProxyRequestListener, filter: { urls: string[] }): void;
	removeListener(listener: FirefoxProxyRequestListener): void;
	hasListener(listener: FirefoxProxyRequestListener): boolean;
}

export interface FirefoxProxyOnErrorEvent {
	addListener(listener: (error: { message: string }) => void): void;
}

export interface FirefoxProxyApi {
	onRequest?: FirefoxProxyOnRequestEvent;
	onError?: FirefoxProxyOnErrorEvent;
}

/**
 * `globalThis` as seen from a Firefox WebExtension.
 *
 * Modelled as a cast target rather than a `declare global { var browser }` so
 * `browser` stays unreachable as a bare identifier: on Chrome it is undeclared,
 * and optional chaining does not guard an undeclared identifier -- `browser?.x`
 * would throw a ReferenceError there, while `globalThis.browser?.x` is just a
 * property read that yields `undefined`.
 */
export interface FirefoxGlobal {
	browser?: {
		proxy?: FirefoxProxyApi;
	};
}
