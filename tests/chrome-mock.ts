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
//   • proxy.settings is a single in-memory proxy config value; every set() is
//     recorded.
//   • storage.onChanged listeners are registered but never fired: tests drive
//     the bridge through its port protocol only, and firing change events
//     would make assertion ordering nondeterministic. (Code under test must
//     not RELY on the mock firing them.)
//
// Install with installChromeMock(); each test gets a fresh instance.

type StorageChangeListener = (
	changes: Record<string, chrome.storage.StorageChange>,
	area: string,
) => void;

export type RecordedAlarm = { name: string; info: chrome.alarms.AlarmCreateInfo };

export type ChromeMock = {
	/** the object installed as globalThis.chrome */
	chrome: typeof chrome;

	// ---- in-memory state ----
	/** chrome.storage.local backing store */
	storageData: Map<string, unknown>;
	/** current chrome.proxy.settings value */
	proxyValue: () => unknown;
	setProxyValue: (value: unknown) => void;
	/** currently scheduled alarms by name */
	alarms: Map<string, chrome.alarms.AlarmCreateInfo>;

	// ---- call recorders (reset with resetCalls) ----
	proxySettingsSetCalls: unknown[];
	alarmCreateCalls: RecordedAlarm[];
	alarmClearCalls: string[];
	runtimeMessages: unknown[];
	resetCalls: () => void;

	// ---- listener registries ----
	onConnectListeners: Array<(port: chrome.runtime.Port) => void>;
	onAlarmListeners: Array<(alarm: chrome.alarms.Alarm) => void>;
	onStorageChangedListeners: StorageChangeListener[];

	// ---- helpers ----
	seedStorage: (items: Record<string, unknown>) => void;
	getStored: (key: string) => unknown;
};

function clone<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

export function installChromeMock(): ChromeMock {
	const storageData = new Map<string, unknown>();
	let proxyValue: unknown = { mode: "system" };
	const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();

	const proxySettingsSetCalls: unknown[] = [];
	const alarmCreateCalls: RecordedAlarm[] = [];
	const alarmClearCalls: string[] = [];
	const runtimeMessages: unknown[] = [];

	const onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
	const onAlarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];
	const onStorageChangedListeners: StorageChangeListener[] = [];

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
			},
		},
		runtime: {
			// chrome.runtime.lastError is checked after every proxy.settings
			// callback; undefined means success
			lastError: undefined as chrome.runtime.LastError | undefined,
			getManifest: () => ({ version: "0.0.0-test" }),
			sendMessage: (message: unknown) => {
				runtimeMessages.push(clone(message));
				return Promise.resolve(undefined);
			},
			onConnect: {
				addListener: (listener: (port: chrome.runtime.Port) => void) => {
					onConnectListeners.push(listener);
				},
			},
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
			settings: {
				get: (
					_details: Record<string, unknown>,
					callback: (details: { value: unknown }) => void,
				) => {
					callback({ value: clone(proxyValue) });
				},
				set: (details: { value: unknown; scope?: string }, callback?: () => void) => {
					proxySettingsSetCalls.push(clone(details));
					proxyValue = clone(details.value);
					callback?.();
				},
			},
		},
	};

	const installed = chromeMock as unknown as typeof chrome;
	(globalThis as { chrome?: typeof chrome }).chrome = installed;

	return {
		chrome: installed,
		storageData,
		proxyValue: () => clone(proxyValue),
		setProxyValue: (value: unknown) => {
			proxyValue = clone(value);
		},
		alarms,
		proxySettingsSetCalls,
		alarmCreateCalls,
		alarmClearCalls,
		runtimeMessages,
		resetCalls: () => {
			proxySettingsSetCalls.length = 0;
			alarmCreateCalls.length = 0;
			alarmClearCalls.length = 0;
			runtimeMessages.length = 0;
		},
		onConnectListeners,
		onAlarmListeners,
		onStorageChangedListeners,
		seedStorage: (items: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(items)) {
				storageData.set(key, clone(value));
			}
		},
		getStored: (key: string) => clone(storageData.get(key)),
	};
}
