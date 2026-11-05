// The browser's proxy settings for the install's one hosted proxy
// (bridge/background.ts): Chromium chrome.proxy fixed_servers with one
// singleProxy and the bypass list, Firefox a proxy.onRequest listener that
// answers every request with the one proxy. A kill switch that is off lets a
// Firefox request fail over to direct; on Chromium the health check takes the
// proxy off instead (utils/proxy-health.ts).
import { shouldBypass, chromeBypassList, deviceRpcApiHost } from "./bypass-rules";
import { getKillSwitch } from "./kill-switch";
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

class ProxyManager {
	private state: ProxyState = { enabled: false, mode: "direct", config: null };
	private firefoxConfig: ProxyConfig | null = null;
	private firefoxListener: FirefoxProxyRequestListener | null = null;
	// off until loadKillSwitch reads the setting (utils/kill-switch.ts)
	private killSwitchEnabled = false;

	async loadKillSwitch(): Promise<void> {
		this.killSwitchEnabled = await getKillSwitch();
	}

	setKillSwitchState(enabled: boolean): void {
		this.killSwitchEnabled = enabled;
	}

	getKillSwitchState(): boolean {
		return this.killSwitchEnabled;
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

			if (this.killSwitchEnabled) {
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
	 * Query the actual live proxy configuration.
	 * Chrome exposes this through chrome.proxy.settings; Firefox proxy.onRequest
	 * does not expose listener state, so storage + in-memory state are the source of truth there.
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

		return new Promise((resolve) => {
			chrome.proxy.settings.get({ incognito: false }, (config) => {
				if (chrome.runtime.lastError) {
					console.error("Error reading proxy settings:", chrome.runtime.lastError);
					resolve({ enabled: false, mode: "direct", config: null });
					return;
				}

				const value = config.value as chrome.proxy.ProxyConfig;

				if (value.mode === "fixed_servers" && value.rules?.singleProxy) {
					const proxy = value.rules.singleProxy;
					const proxyConfig: ProxyConfig = {
						host: proxy.host ?? "",
						port: proxy.port,
						scheme: (proxy.scheme ?? "https") as ProxyConfig["scheme"],
					};

					chrome.storage.local.get([STORAGE_KEYS.CONFIG], (result) => {
						const stored = result[STORAGE_KEYS.CONFIG] as ProxyConfig | undefined;
						if (stored?.username) proxyConfig.username = stored.username;
						if (stored?.password) proxyConfig.password = stored.password;
						resolve({ enabled: true, mode: "fixed", config: proxyConfig });
					});
				} else if (value.mode === "pac_script") {
					resolve({ enabled: true, mode: "pac", config: null });
				} else {
					resolve({ enabled: false, mode: "direct", config: null });
				}
			});
		});
	}

	/** Enable the VPN proxy with the given configuration. */
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

		return new Promise((resolve, reject) => {
			chrome.proxy.settings.set({ value: chromeProxyConfig, scope: "regular" }, () => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
					return;
				}

				this.state = { enabled: true, mode: "fixed", config };
				chrome.storage.local.set({
					[STORAGE_KEYS.ENABLED]: true,
					[STORAGE_KEYS.CONFIG]: config,
				});
				resolve();
			});
		});
	}

	/** Disable the VPN proxy and restore direct connection. */
	async disable(): Promise<void> {
		if (isFirefoxProxyApiAvailable()) {
			this.removeFirefoxProxyListener();
			this.state = { enabled: false, mode: "direct", config: null };
			chrome.storage.local.set({
				[STORAGE_KEYS.ENABLED]: false,
				[STORAGE_KEYS.CONFIG]: null,
			});
			return;
		}

		return new Promise((resolve, reject) => {
			chrome.proxy.settings.set({ value: { mode: "direct" }, scope: "regular" }, () => {
				if (chrome.runtime.lastError) {
					reject(new Error(chrome.runtime.lastError.message));
					return;
				}

				this.state = { enabled: false, mode: "direct", config: null };
				chrome.storage.local.set({
					[STORAGE_KEYS.ENABLED]: false,
					[STORAGE_KEYS.CONFIG]: null,
				});
				resolve();
			});
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

	/** Restore saved intent without turning an observation/application failure into a disconnect. */
	async restoreState(): Promise<void> {
		await this.loadKillSwitch();

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

		const actualState = await this.getActualProxyState();
		if (actualState.enabled) {
			this.state = actualState;
			return;
		}

		const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.CONFIG]);
		if (result[STORAGE_KEYS.ENABLED] && result[STORAGE_KEYS.CONFIG]) {
			try {
				await this.enable(result[STORAGE_KEYS.CONFIG] as ProxyConfig);
			} catch {
				throw new Error("Failed to restore saved proxy config");
			}
		}
	}
}

export const proxyManager = new ProxyManager();
