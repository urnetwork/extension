// Minimal hand-rolled chrome.* mock — exactly the surface the background
// bridge service touches, nothing more. Deliberately not a full WebExtension
// polyfill (no heavyweight dep): each API is an in-memory model plus call
// recorders so tests can assert both outcomes (what state the extension is in)
// and non-events (what was NOT touched — the zero-disruption property of
// REFRESH_JWT).
//
// Semantics mirrored from real chrome where the code under test depends on
// them:
//   • storage.local get/set/remove support BOTH the promise and the callback
//     form (proxy-manager uses callbacks, the bridge uses await).
//   • storage values round-trip through structuredClone, like the real
//     serialization boundary, so tests catch accidental object aliasing.
//   • proxy.settings is Chrome's precedence model: policy over an extension
//     with priority over this extension over an extension that yields to it
//     over the system setting ({ mode: "system" }). get() answers the value in
//     effect with its levelOfControl; set() and clear() change this
//     extension's own value only, so a set under an extension with priority
//     changes nothing in effect, and a clear brings back what is under it.
//     Every set() and clear() is recorded; onChange listeners are registered,
//     and fired by tests that are about a change.
//   • storage.onChanged listeners are registered but never fired: tests drive
//     the bridge through its port protocol only, and firing change events
//     would make assertion ordering nondeterministic. (Code under test must
//     not RELY on the mock firing them; a test that is about a change
//     delivers it to onStorageChangedListeners by hand.)
//   • i18n.getMessage answers from the extension's generated catalogs
//     (public/_locales/<locale>/messages.json), English unless a test picks
//     another locale, and "" for a key the catalog lacks, as Chrome does.
//
// Install with installChromeMock(); each test gets a fresh instance.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type StorageChangeListener = (
	changes: Record<string, chrome.storage.StorageChange>,
	area: string,
) => void;

export type RecordedAlarm = { name: string; info: chrome.alarms.AlarmCreateInfo };

export type ProxyLevelOfControl =
	| "not_controllable"
	| "controlled_by_other_extensions"
	| "controllable_by_this_extension"
	| "controlled_by_this_extension";

export type ProxySettingChange = { value: unknown; levelOfControl: ProxyLevelOfControl };

export type ChromeMock = {
	/** the object installed as globalThis.chrome */
	chrome: typeof chrome;

	// ---- in-memory state ----
	/** chrome.storage.local backing store */
	storageData: Map<string, unknown>;
	/** the chrome.proxy.settings value in effect */
	proxyValue: () => unknown;
	/** its levelOfControl for this extension */
	levelOfControl: () => ProxyLevelOfControl;
	/** sets this extension's own proxy value (as an earlier set() would have) */
	setProxyValue: (value: unknown) => void;
	/** this extension's own value, null when it set none or cleared it */
	ownProxyValue: () => unknown;
	/** another extension, with priority over this one, holds the setting (null: none) */
	setPriorityExtensionProxy: (value: unknown) => void;
	/** another extension that yields to this one holds the setting (null: none) */
	setYieldingExtensionProxy: (value: unknown) => void;
	/** policy fixes the setting (null: no policy) */
	setPolicyProxy: (value: unknown) => void;
	/** currently scheduled alarms by name */
	alarms: Map<string, chrome.alarms.AlarmCreateInfo>;

	// ---- call recorders (reset with resetCalls) ----
	proxySettingsSetCalls: unknown[];
	proxySettingsClearCalls: unknown[];
	alarmCreateCalls: RecordedAlarm[];
	alarmClearCalls: string[];
	runtimeMessages: unknown[];
	resetCalls: () => void;

	// ---- listener registries ----
	onConnectListeners: Array<(port: chrome.runtime.Port) => void>;
	onAlarmListeners: Array<(alarm: chrome.alarms.Alarm) => void>;
	onStorageChangedListeners: StorageChangeListener[];
	/** chrome.runtime.onMessage listeners (an extension page's); tests deliver to them */
	onMessageListeners: Array<(message: unknown) => void>;
	/** chrome.proxy.settings.onChange listeners; fireProxyChange delivers to them */
	onProxyChangeListeners: Array<(details: ProxySettingChange) => void>;
	fireProxyChange: () => void;
	/** chrome.proxy.onProxyError listeners (the background's); tests deliver to them */
	onProxyErrorListeners: Array<(details: { error: string; details: string; fatal: boolean }) => void>;
	/** chrome.runtime.onMessage listeners that answer (the background's), with their sendResponse */
	onMessageResponders: Array<
		(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void
	>;

	// ---- i18n ----
	/** answers chrome.i18n from this locale's catalog from now on */
	setLocale: (locale: string) => void;

	// ---- helpers ----
	seedStorage: (items: Record<string, unknown>) => void;
	getStored: (key: string) => unknown;
};

function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

const LOCALES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/_locales");
const catalogs = new Map<string, Record<string, { message: string }>>();

/** The extension's generated catalog for `locale` (public/_locales). */
export function catalog(locale: string): Record<string, { message: string }> {
	let messages = catalogs.get(locale);
	if (!messages) {
		messages = JSON.parse(readFileSync(path.join(LOCALES_DIR, locale, "messages.json"), "utf8")) as Record<
			string,
			{ message: string }
		>;
		catalogs.set(locale, messages);
	}
	return messages;
}

/** The text `key` has in `locale` (English by default), as chrome.i18n answers it. */
export function message(key: string, locale = "en"): string {
	return catalog(locale)[key]?.message ?? "";
}

export const SYSTEM_PROXY = { mode: "system" };

export function installChromeMock(): ChromeMock {
	const storageData = new Map<string, unknown>();
	// the precedence layers of the proxy setting, highest first
	let policyProxy: unknown = null;
	let priorityExtensionProxy: unknown = null;
	let ownProxy: unknown = null;
	let yieldingExtensionProxy: unknown = null;
	const systemProxy: unknown = SYSTEM_PROXY;
	const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
	let locale = "en";

	const proxySettingsSetCalls: unknown[] = [];
	const proxySettingsClearCalls: unknown[] = [];
	const alarmCreateCalls: RecordedAlarm[] = [];
	const alarmClearCalls: string[] = [];
	const runtimeMessages: unknown[] = [];

	const onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
	const onAlarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
	const onStorageChangedListeners: StorageChangeListener[] = [];
	const onMessageListeners: Array<(message: unknown) => void> = [];
	const onProxyChangeListeners: Array<(details: ProxySettingChange) => void> = [];
	const onProxyErrorListeners: Array<(details: { error: string; details: string; fatal: boolean }) => void> = [];
	const onMessageResponders: ChromeMock["onMessageResponders"] = [];

	function proxyInEffect(): ProxySettingChange {
		if (policyProxy !== null) return { value: policyProxy, levelOfControl: "not_controllable" };
		if (priorityExtensionProxy !== null) {
			return { value: priorityExtensionProxy, levelOfControl: "controlled_by_other_extensions" };
		}
		if (ownProxy !== null) return { value: ownProxy, levelOfControl: "controlled_by_this_extension" };
		if (yieldingExtensionProxy !== null) {
			return { value: yieldingExtensionProxy, levelOfControl: "controllable_by_this_extension" };
		}
		return { value: systemProxy, levelOfControl: "controllable_by_this_extension" };
	}

	function storageGet(keys: string | string[] | null): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		const list =
			keys == null ? [...storageData.keys()] : Array.isArray(keys) ? keys : [keys];
		for (const key of list) {
			if (storageData.has(key)) {
				result[key] = clone(storageData.get(key));
			}
		}
		return result;
	}

	// promise form when no callback is passed, callback form otherwise —
	// matching MV3 chrome
	function dual<T>(value: T, callback?: (value: T) => void): Promise<T> | void {
		if (typeof callback === "function") {
			callback(value);
			return;
		}
		return Promise.resolve(value);
	}

	const chromeMock = {
		storage: {
			local: {
				get: (
					keys: string | string[] | null,
					callback?: (items: Record<string, unknown>) => void,
				) => dual(storageGet(keys), callback),
				set: (items: Record<string, unknown>, callback?: () => void) => {
					for (const [key, value] of Object.entries(items)) {
						storageData.set(key, clone(value));
					}
					return dual(undefined as void, callback);
				},
				remove: (keys: string | string[], callback?: () => void) => {
					for (const key of Array.isArray(keys) ? keys : [keys]) {
						storageData.delete(key);
					}
					return dual(undefined as void, callback);
				},
			},
			onChanged: {
				addListener: (listener: StorageChangeListener) => {
					onStorageChangedListeners.push(listener);
				},
				removeListener: (listener: StorageChangeListener) => {
					const index = onStorageChangedListeners.indexOf(listener);
					if (0 <= index) onStorageChangedListeners.splice(index, 1);
				},
			},
		},
		runtime: {
			// chrome.runtime.lastError is checked after every proxy.settings
			// callback; undefined means success
			lastError: undefined as chrome.runtime.LastError | undefined,
			getManifest: () => ({ version: "0.0.0-test" }),
			getURL: (resource: string) => `chrome-extension://test-extension-id/${resource}`,
			sendMessage: (message: unknown) => {
				runtimeMessages.push(clone(message));
				return Promise.resolve(undefined);
			},
			onConnect: {
				addListener: (listener: (port: chrome.runtime.Port) => void) => {
					onConnectListeners.push(listener);
				},
			},
			onMessage: {
				addListener: (listener: (message: unknown) => void) => {
					onMessageListeners.push(listener);
					onMessageResponders.push(listener as ChromeMock["onMessageResponders"][number]);
				},
				removeListener: (listener: (message: unknown) => void) => {
					const index = onMessageListeners.indexOf(listener);
					if (0 <= index) onMessageListeners.splice(index, 1);
					const responder = onMessageResponders.indexOf(listener as ChromeMock["onMessageResponders"][number]);
					if (0 <= responder) onMessageResponders.splice(responder, 1);
				},
				hasListener: (listener: (message: unknown) => void) => onMessageListeners.includes(listener),
			},
			// the background's external messages; no test delivers to them
			onMessageExternal: {
				addListener: () => {},
			},
		},
		// the background's legacy sign-in tab listener; no test delivers to it
		tabs: {
			onUpdated: {
				addListener: () => {},
			},
			remove: () => Promise.resolve(),
		},
		alarms: {
			create: (name: string, info: chrome.alarms.AlarmCreateInfo) => {
				alarmCreateCalls.push({ name, info });
				alarms.set(name, info);
				return Promise.resolve();
			},
			clear: (name: string) => {
				alarmClearCalls.push(name);
				return Promise.resolve(alarms.delete(name));
			},
			onAlarm: {
				addListener: (listener: (alarm: chrome.alarms.Alarm) => void) => {
					onAlarmListeners.push(listener);
				},
			},
		},
		proxy: {
			onProxyError: {
				addListener: (listener: (details: { error: string; details: string; fatal: boolean }) => void) => {
					onProxyErrorListeners.push(listener);
				},
			},
			settings: {
				get: (
					_details: Record<string, unknown>,
					callback: (details: { value: unknown; levelOfControl: ProxyLevelOfControl }) => void,
				) => {
					const inEffect = proxyInEffect();
					callback({ value: clone(inEffect.value), levelOfControl: inEffect.levelOfControl });
				},
				set: (details: { value: unknown; scope?: string }, callback?: () => void) => {
					proxySettingsSetCalls.push(clone(details));
					ownProxy = clone(details.value);
					callback?.();
				},
				clear: (details: { scope?: string }, callback?: () => void) => {
					proxySettingsClearCalls.push(clone(details));
					ownProxy = null;
					callback?.();
				},
				onChange: {
					addListener: (listener: (details: ProxySettingChange) => void) => {
						onProxyChangeListeners.push(listener);
					},
				},
			},
		},
		i18n: {
			getMessage: (key: string) => message(key, locale),
			getUILanguage: () => locale,
		},
	};

	const installed = chromeMock as unknown as typeof chrome;
	(globalThis as { chrome?: typeof chrome }).chrome = installed;

	return {
		chrome: installed,
		storageData,
		proxyValue: () => clone(proxyInEffect().value),
		levelOfControl: () => proxyInEffect().levelOfControl,
		setProxyValue: (value: unknown) => {
			ownProxy = clone(value);
		},
		ownProxyValue: () => clone(ownProxy),
		setPriorityExtensionProxy: (value: unknown) => {
			priorityExtensionProxy = clone(value);
		},
		setYieldingExtensionProxy: (value: unknown) => {
			yieldingExtensionProxy = clone(value);
		},
		setPolicyProxy: (value: unknown) => {
			policyProxy = clone(value);
		},
		alarms,
		proxySettingsSetCalls,
		proxySettingsClearCalls,
		alarmCreateCalls,
		alarmClearCalls,
		runtimeMessages,
		resetCalls: () => {
			proxySettingsSetCalls.length = 0;
			proxySettingsClearCalls.length = 0;
			alarmCreateCalls.length = 0;
			alarmClearCalls.length = 0;
			runtimeMessages.length = 0;
		},
		onConnectListeners,
		onAlarmListeners,
		onStorageChangedListeners,
		onMessageListeners,
		onProxyChangeListeners,
		onProxyErrorListeners,
		onMessageResponders,
		fireProxyChange: () => {
			const inEffect = proxyInEffect();
			for (const listener of [...onProxyChangeListeners]) {
				listener({ value: clone(inEffect.value), levelOfControl: inEffect.levelOfControl });
			}
		},
		setLocale: (next: string) => {
			locale = next;
		},
		seedStorage: (items: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(items)) {
				storageData.set(key, clone(value));
			}
		},
		getStored: (key: string) => clone(storageData.get(key)),
	};
}
