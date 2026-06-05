import type { PacSlot } from "./pac-script";
import { shouldBypass, CHROME_BYPASS_LIST } from "./bypass-rules";
import { getKillSwitch } from "./kill-switch";

export interface ProxyConfig {
	host: string;
	port?: number;
	scheme: "http" | "https" | "socks4" | "socks5";
	username?: string;
	password?: string;
}

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

type FirefoxProxyInfo = {
	type: "http" | "https" | "socks" | "socks4" | "direct";
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	failoverTimeout?: number;
};

type FirefoxProxyDetails = {
	url: string;
};

function getFirefoxProxyApi(): any | null {
	return (globalThis as any).browser?.proxy ?? null;
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
	private firefoxListener: ((details: FirefoxProxyDetails) => FirefoxProxyInfo[]) | null = null;
	private firefoxMultiIpSlots: PacSlot[] = [];
	private killSwitchEnabled = true;

	async loadKillSwitch(): Promise<void> {
		this.killSwitchEnabled = await getKillSwitch();
	}

	setKillSwitchState(enabled: boolean): void {
		this.killSwitchEnabled = enabled;
	}

	getKillSwitchState(): boolean {
		return this.killSwitchEnabled;
	}

	private ensureFirefoxListener(): void {
		if (this.firefoxListener) return;

		this.firefoxListener = (details: FirefoxProxyDetails): FirefoxProxyInfo[] => {
			const config = this.firefoxConfig;
			if (!config) return [{ type: "direct" }];

			try {
				const { hostname } = new URL(details.url);
				if (shouldBypass(hostname)) return [{ type: "direct" }];
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
	}

	private addFirefoxProxyListener(config: ProxyConfig): void {
		const firefoxProxyApi = getFirefoxProxyApi();
		if (!firefoxProxyApi?.onRequest) return;

		this.ensureFirefoxListener();
		this.firefoxConfig = config;

		try {
			if (firefoxProxyApi.onRequest.hasListener(this.firefoxListener)) {
				firefoxProxyApi.onRequest.removeListener(this.firefoxListener);
			}
		} catch {
			// Ignore stale listener cleanup failures.
		}

		firefoxProxyApi.onRequest.addListener(this.firefoxListener, {
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
		this.firefoxMultiIpSlots = [];
	}

	enableMultiIp(slots: PacSlot[]): void {
		if (!isFirefoxProxyApiAvailable() || slots.length === 0) return;

		const firefoxProxyApi = getFirefoxProxyApi();
		this.removeFirefoxProxyListener();

		this.firefoxMultiIpSlots = slots;

		this.firefoxListener = (details: FirefoxProxyDetails): FirefoxProxyInfo[] => {
			if (this.firefoxMultiIpSlots.length === 0) return [{ type: "direct" }];

			try {
				const { hostname } = new URL(details.url);
				if (shouldBypass(hostname)) return [{ type: "direct" }];
			} catch {
				return [{ type: "direct" }];
			}

			const proxies: FirefoxProxyInfo[] = this.firefoxMultiIpSlots.map((s) => ({
				type: "https" as const,
				host: s.host,
				port: s.port,
				failoverTimeout: 5,
			}));

			if (!this.killSwitchEnabled) {
				proxies.push({ type: "direct" });
			}
			return proxies;
		};

		firefoxProxyApi.onRequest.addListener(this.firefoxListener, {
			urls: ["<all_urls>"],
		});

		this.state = { enabled: true, mode: "pac", config: null };
		chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: true });
	}

	getMultiIpSlots(): PacSlot[] {
		return [...this.firefoxMultiIpSlots];
	}

	disableMultiIp(): void {
		this.removeFirefoxProxyListener();
		this.state = { enabled: false, mode: "direct", config: null };
		chrome.storage.local.set({
			[STORAGE_KEYS.ENABLED]: false,
			[STORAGE_KEYS.CONFIG]: null,
		});
	}

	/**
	 * Query the actual live proxy configuration.
	 * Chrome exposes this through chrome.proxy.settings; Firefox proxy.onRequest
	 * does not expose listener state, so storage + in-memory state are the source of truth there.
	 */
	async getActualProxyState(): Promise<ProxyState> {
		if (isFirefoxProxyApiAvailable()) {
			return new Promise((resolve) => {
				if (this.firefoxMultiIpSlots.length > 0) {
					resolve({ enabled: true, mode: "pac", config: null });
					return;
				}

				chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.CONFIG], (result) => {
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
				});
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
				bypassList: CHROME_BYPASS_LIST,
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

	/** Restore proxy state on extension startup. */
	async restoreState(): Promise<void> {
		await this.loadKillSwitch();

		if (isFirefoxProxyApiAvailable()) {
			const result = await chrome.storage.local.get([STORAGE_KEYS.ENABLED, STORAGE_KEYS.CONFIG]);
			const stored = result[STORAGE_KEYS.CONFIG] as ProxyConfig | undefined;
			if (result[STORAGE_KEYS.ENABLED] && stored) {
				try {
					await this.enable(stored);
				} catch (err) {
					console.error("Failed to restore Firefox proxy config:", err);
					await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: false });
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
			} catch (err) {
				console.error("Failed to restore proxy config:", err);
				await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: false });
			}
		}
	}
}

export const proxyManager = new ProxyManager();
