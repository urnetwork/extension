// The browser's proxy settings for the install's one hosted proxy
// (bridge/background.ts): Chromium chrome.proxy fixed_servers with one
// singleProxy and the bypass list, Firefox a proxy.onRequest listener that
// answers every request with the one proxy. A kill switch that is off lets a
// Firefox request fail over to direct; on Chromium the health check takes the
// proxy off instead (utils/proxy-health.ts). Out of balance, neither happens:
// the proxy holds the browser's traffic whatever the kill switch says
// (setTrafficHold, utils/out-of-balance.ts).
//
// Taking the proxy off releases the setting (Chromium chrome.proxy.settings.clear,
// Firefox removes its listener): the browser goes back to its own proxy
// settings, a system or corporate proxy included, not to "direct". On
// Chromium the setting is the extension's only while the browser says so
// (levelOfControl): another extension can hold it with priority, and policy can
// fix it. The extension never applies its proxy over either.
import { shouldBypass, chromeBypassList, deviceRpcApiHost } from "./bypass-rules";
import { getKillSwitch } from "./kill-switch";
import {
	ProxyControlError,
	controlOf,
	isControlRefusal,
	type ProxySettingReading,
} from "./proxy-control";
import { STORAGE_KEY_OUT_OF_BALANCE } from "./proxy-health-report";
import type {
	FirefoxGlobal,
	FirefoxProxyApi,
	FirefoxProxyDetails,
	FirefoxProxyInfo,
	FirefoxProxyRequestListener,
} from "../types/firefox-webext";

export interface ProxyConfig {
	host: string;
	port?: number;
	scheme: "http" | "https" | "socks4" | "socks5";
	username?: string;
	password?: string;
}

// "pac" is only ever an older version's multi-IP pool, which the background
// replaces on start (bridge/background.ts migrateLegacyMultiIp)
export type ProxyMode = "fixed" | "pac" | "direct";

export interface ProxyState {
	enabled: boolean;
	mode: ProxyMode;
	config: ProxyConfig | null;
}

const STORAGE_KEYS = {
	ENABLED: "proxy_enabled",
	CONFIG: "proxy_config",
} as const;

function getFirefoxProxyApi(): FirefoxProxyApi | null {
	return (globalThis as FirefoxGlobal).browser?.proxy ?? null;
}

function isFirefoxProxyApiAvailable(): boolean {
	return Boolean(getFirefoxProxyApi()?.onRequest);
}

function firefoxProxyType(scheme: ProxyConfig["scheme"]): FirefoxProxyInfo["type"] {
	return scheme === "socks5" ? "socks" : scheme;
}

function lastErrorMessage(): string | null {
	const error = chrome.runtime.lastError;
	return error ? (error.message ?? "proxy settings error") : null;
}

// chrome.proxy.settings.get: what is in effect, and who holds it
function readChromeSetting(): Promise<{ reading: ProxySettingReading; value: chrome.proxy.ProxyConfig | null }> {
	return new Promise((resolve) => {
		chrome.proxy.settings.get({ incognito: false }, (details) => {
			const error = lastErrorMessage();
			if (error) {
				console.error("Error reading proxy settings:", error);
				resolve({ reading: { control: "available", mode: undefined }, value: null });
				return;
			}
			const value = (details?.value ?? null) as chrome.proxy.ProxyConfig | null;
			resolve({
				reading: { control: controlOf(details?.levelOfControl), mode: value?.mode },
				value,
			});
		});
	});
}

// chrome.proxy.settings.clear: the extension's value goes, and the browser's
// own settings (or another extension's) apply again
function clearChromeSetting(): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.proxy.settings.clear({ scope: "regular" }, () => {
			const error = lastErrorMessage();
			if (error) {
				reject(new Error(error));
				return;
			}
			resolve();
		});
	});
}

class ProxyManager {
	private state: ProxyState = { enabled: false, mode: "direct", config: null };
	private firefoxConfig: ProxyConfig | null = null;
	private firefoxListener: FirefoxProxyRequestListener | null = null;
	// off until loadKillSwitch reads the setting (utils/kill-switch.ts)
	private killSwitchEnabled = false;
	// an out-of-balance episode: the proxy holds the traffic whatever the kill
	// switch says (utils/proxy-health.ts)
	private trafficHeld = false;

	async loadKillSwitch(): Promise<void> {
		this.killSwitchEnabled = await getKillSwitch();
	}

	setKillSwitchState(enabled: boolean): void {
		this.killSwitchEnabled = enabled;
	}

	getKillSwitchState(): boolean {
		return this.killSwitchEnabled;
	}

	/** Holds the traffic at the proxy, with no direct fallback, while `held`. */
	setTrafficHold(held: boolean): void {
		this.trafficHeld = held;
	}

	isTrafficHeld(): boolean {
		return this.trafficHeld;
	}

	// a restarted background reads whether an out-of-balance episode holds it
	private async loadTrafficHold(): Promise<void> {
		const result = await chrome.storage.local.get(STORAGE_KEY_OUT_OF_BALANCE);
		this.trafficHeld = Boolean(result[STORAGE_KEY_OUT_OF_BALANCE]);
	}

	isListenerActive(): boolean {
		const firefoxProxyApi = getFirefoxProxyApi();
		if (!firefoxProxyApi?.onRequest || !this.firefoxListener) return false;
		try {
			return firefoxProxyApi.onRequest.hasListener(this.firefoxListener);
		} catch {
			return false;
		}
	}

	/** Returns the single-proxy listener, creating it on first use. */
	private ensureFirefoxListener(): FirefoxProxyRequestListener {
		if (this.firefoxListener) return this.firefoxListener;

		this.firefoxListener = (details: FirefoxProxyDetails): FirefoxProxyInfo[] => {
			const config = this.firefoxConfig;
			if (!config) return [{ type: "direct" }];

			try {
				const { hostname } = new URL(details.url);
				// the connected proxy's own device-rpc api host must stay direct
				const apiHost = deviceRpcApiHost(config.host);
				if (shouldBypass(hostname, apiHost ? [apiHost] : [])) return [{ type: "direct" }];
			} catch {
				return [{ type: "direct" }];
			}

			const proxyInfo: FirefoxProxyInfo = {
				type: firefoxProxyType(config.scheme),
				host: config.host,
				port: config.port,
				failoverTimeout: 5,
			};

			if (config.username) proxyInfo.username = config.username;
			if (config.password) proxyInfo.password = config.password;

			if (this.killSwitchEnabled || this.trafficHeld) {
				return [proxyInfo];
			}
			return [proxyInfo, { type: "direct" }];
		};

		return this.firefoxListener;
	}

	private addFirefoxProxyListener(config: ProxyConfig): void {
		const firefoxProxyApi = getFirefoxProxyApi();
		if (!firefoxProxyApi?.onRequest) return;

		const listener = this.ensureFirefoxListener();
		this.firefoxConfig = config;

		try {
			if (firefoxProxyApi.onRequest.hasListener(listener)) {
				firefoxProxyApi.onRequest.removeListener(listener);
			}
		} catch {
			// Ignore stale listener cleanup failures.
		}

		firefoxProxyApi.onRequest.addListener(listener, {
			urls: ["<all_urls>"],
		});
	}

	private removeFirefoxProxyListener(): void {
		const firefoxProxyApi = getFirefoxProxyApi();
		if (firefoxProxyApi?.onRequest && this.firefoxListener) {
			try {
				if (firefoxProxyApi.onRequest.hasListener(this.firefoxListener)) {
					firefoxProxyApi.onRequest.removeListener(this.firefoxListener);
				}
			} catch {
				// Ignore cleanup failures.
			}
		}
		this.firefoxConfig = null;
		// Note: this.firefoxListener is intentionally NOT nulled here. Keeping the
		// reference allows isListenerActive() to call hasListener() after removal and
		// correctly return false, rather than short-circuiting on the null check.
	}

	/**
	 * Who holds the browser's proxy setting, and the mode in effect. Firefox's
	 * listener is consulted per request, so there the extension holds it while
	 * the listener is in place.
	 */
	async readControl(): Promise<ProxySettingReading> {
		if (isFirefoxProxyApiAvailable()) {
			return this.isListenerActive()
				? { control: "ours", mode: "fixed_servers" }
				: { control: "available", mode: undefined };
		}
		return (await readChromeSetting()).reading;
	}

	/**
	 * Query the actual live proxy configuration: the extension's proxy, if it is
	 * the one in effect. Chrome exposes this through chrome.proxy.settings, where
	 * a value another extension or policy holds is not this extension's; Firefox
	 * proxy.onRequest does not expose listener state, so storage + in-memory
	 * state are the source of truth there.
	 */
	async getActualProxyState(): Promise<ProxyState> {
		if (isFirefoxProxyApiAvailable()) {
			return new Promise((resolve) => {
				chrome.storage.local.get(
					[STORAGE_KEYS.ENABLED, STORAGE_KEYS.CONFIG],
					(result) => {
						// Check in-memory fixed config or storage fixed config
						if (this.firefoxConfig) {
							resolve({ enabled: true, mode: "fixed", config: this.firefoxConfig });
							return;
						}

						const stored = result[STORAGE_KEYS.CONFIG] as ProxyConfig | undefined;
						if (result[STORAGE_KEYS.ENABLED] && stored) {
							resolve({ enabled: true, mode: "fixed", config: stored });
							return;
						}

						resolve({ enabled: false, mode: "direct", config: null });
					},
				);
			});
		}

		const { reading, value } = await readChromeSetting();
		// another extension's proxy, or policy's, is not this extension's to report
		// or to check: the browser does not send through this extension's proxy
		if (reading.control !== "ours" || !value) {
			return { enabled: false, mode: "direct", config: null };
		}

		if (value.mode === "fixed_servers" && value.rules?.singleProxy) {
			const proxy = value.rules.singleProxy;
			const proxyConfig: ProxyConfig = {
				host: proxy.host ?? "",
				port: proxy.port,
				scheme: (proxy.scheme ?? "https") as ProxyConfig["scheme"],
			};
			const result = await chrome.storage.local.get([STORAGE_KEYS.CONFIG]);
			const stored = result[STORAGE_KEYS.CONFIG] as ProxyConfig | undefined;
			if (stored?.username) proxyConfig.username = stored.username;
			if (stored?.password) proxyConfig.password = stored.password;
			return { enabled: true, mode: "fixed", config: proxyConfig };
		}
		if (value.mode === "pac_script") {
			return { enabled: true, mode: "pac", config: null };
		}
		return { enabled: false, mode: "direct", config: null };
	}

	/**
	 * Enable the VPN proxy with the given configuration. On Chromium it throws a
	 * ProxyControlError, and leaves nothing of its own set, when the browser
	 * keeps the setting from this extension (another extension holds it, or
	 * policy).
	 */
	async enable(config: ProxyConfig): Promise<void> {
		if (isFirefoxProxyApiAvailable()) {
			this.addFirefoxProxyListener(config);
			this.state = { enabled: true, mode: "fixed", config };
			chrome.storage.local.set({
				[STORAGE_KEYS.ENABLED]: true,
				[STORAGE_KEYS.CONFIG]: config,
			});
			return;
		}

		const before = (await readChromeSetting()).reading;
		if (isControlRefusal(before.control)) {
			throw new ProxyControlError(before.control);
		}

		const chromeProxyConfig: chrome.proxy.ProxyConfig = {
			mode: "fixed_servers",
			rules: {
				singleProxy: {
					scheme: config.scheme,
					host: config.host,
					port: config.port,
				},
				bypassList: chromeBypassList(
					[deviceRpcApiHost(config.host)].filter((h): h is string => h !== null),
				),
			},
		};

		await new Promise<void>((resolve, reject) => {
			chrome.proxy.settings.set({ value: chromeProxyConfig, scope: "regular" }, () => {
				const error = lastErrorMessage();
				if (error) {
					reject(new Error(error));
					return;
				}
				resolve();
			});
		});

		// The browser applies a value only while nothing with priority holds the
		// setting. One that took it in the meantime would leave this value under
		// its own, to come back when it goes: take it off again.
		const after = (await readChromeSetting()).reading;
		if (after.control !== "ours") {
			await clearChromeSetting().catch(() => {});
			throw new ProxyControlError(isControlRefusal(after.control) ? after.control : "other_extension");
		}

		this.state = { enabled: true, mode: "fixed", config };
		chrome.storage.local.set({
			[STORAGE_KEYS.ENABLED]: true,
			[STORAGE_KEYS.CONFIG]: config,
		});
	}

	/**
	 * Takes the VPN proxy off and releases the browser's proxy setting, so the
	 * browser's own settings apply again (a system or corporate proxy, or
	 * direct), rather than overriding them with "direct".
	 */
	async disable(): Promise<void> {
		if (isFirefoxProxyApiAvailable()) {
			// Firefox: the extension sets no proxy setting, so removing its
			// listener is the release
			this.removeFirefoxProxyListener();
			this.state = { enabled: false, mode: "direct", config: null };
			chrome.storage.local.set({
				[STORAGE_KEYS.ENABLED]: false,
				[STORAGE_KEYS.CONFIG]: null,
			});
			return;
		}

		await clearChromeSetting();
		this.state = { enabled: false, mode: "direct", config: null };
		chrome.storage.local.set({
			[STORAGE_KEYS.ENABLED]: false,
			[STORAGE_KEYS.CONFIG]: null,
		});
	}

	/** Atomically swap to a new proxy config without transitioning through direct. */
	async swap(config: ProxyConfig): Promise<void> {
		return this.enable(config);
	}

	/** Return the cached proxy state. For live state use getActualProxyState(). */
	getState(): ProxyState {
		return { ...this.state };
	}

	/** Sync the internal cache from an externally-queried state object. */
	syncState(state: ProxyState): void {
		this.state = { ...state };
	}

	/**
	 * Restore saved intent without turning an observation/application failure
	 * into a disconnect. Never applies the saved proxy over another extension's
	 * (one with priority, or one that yields to this extension) or over policy:
	 * the saved intent stays for a later start.
	 */
	async restoreState(): Promise<void> {
		await this.loadKillSwitch();
		await this.loadTrafficHold();

		if (isFirefoxProxyApiAvailable()) {
			const result = await chrome.storage.local.get([
				STORAGE_KEYS.ENABLED,
				STORAGE_KEYS.CONFIG,
				"multi_ip_slots",
			]);

			// An older version's pool: its saved fixed config, if any, is stale, so
			// nothing is restored, and the background replaces the pool with the
			// install's one client (bridge/background.ts migrateLegacyMultiIp)
			if (result["multi_ip_slots"] !== undefined) {
				return;
			}

			const stored = result[STORAGE_KEYS.CONFIG] as ProxyConfig | undefined;
			if (result[STORAGE_KEYS.ENABLED] && stored) {
				try {
					await this.enable(stored);
				} catch {
					throw new Error("Failed to restore saved Firefox proxy config");
				}
			}
			return;
		}

		const { reading } = await readChromeSetting();
		const actualState = await this.getActualProxyState();
		if (actualState.enabled) {
			this.state = actualState;
			return;
		}

		const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.CONFIG]);
		const intended = Boolean(result[STORAGE_KEYS.ENABLED] && result[STORAGE_KEYS.CONFIG]);

		if (reading.control === "ours") {
			// This extension's value is in effect but is no proxy: an older
			// version's disconnect set "direct" rather than releasing the setting.
			// Released, unless the saved intent applies the proxy over it below.
			if (!intended) {
				await clearChromeSetting().catch((err) => {
					console.error("Failed to release the proxy setting:", err);
				});
				return;
			}
		} else if (reading.control !== "available" || reading.mode !== "system") {
			// another extension's proxy, or policy: never applied over
			return;
		}

		if (intended) {
			try {
				await this.enable(result[STORAGE_KEYS.CONFIG] as ProxyConfig);
			} catch {
				throw new Error("Failed to restore saved proxy config");
			}
		}
	}
}

export const proxyManager = new ProxyManager();
