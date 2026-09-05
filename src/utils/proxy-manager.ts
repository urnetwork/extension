import type { PacSlot } from "./pac-script";
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
		this.firefoxMultiIpSlots = [];
		// Note: this.firefoxListener is intentionally NOT nulled here. Keeping the
		// reference allows isListenerActive() to call hasListener() after removal and
		// correctly return false, rather than short-circuiting on the null check.
	}

	enableMultiIp(slots: PacSlot[]): void {
		if (!isFirefoxProxyApiAvailable() || slots.length === 0) return;

		const onRequest = getFirefoxProxyApi()?.onRequest;
		// isFirefoxProxyApiAvailable() above already established this; the explicit
		// check is what narrows the optional event for the type checker.
		if (!onRequest) return;

		this.removeFirefoxProxyListener();

		this.firefoxMultiIpSlots = slots;

		this.firefoxListener = (details: FirefoxProxyDetails): FirefoxProxyInfo[] => {
			if (this.firefoxMultiIpSlots.length === 0) return [{ type: "direct" }];

			try {
				const { hostname } = new URL(details.url);
				const apiHosts = this.firefoxMultiIpSlots
					.map((s) => deviceRpcApiHost(s.host))
					.filter((h): h is string => h !== null);
				if (shouldBypass(hostname, apiHosts)) return [{ type: "direct" }];
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

		onRequest.addListener(this.firefoxListener, {
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
			// In-memory slots present: listener is active
			if (this.firefoxMultiIpSlots.length > 0) {
				return Promise.resolve({ enabled: true, mode: "pac" as ProxyMode, config: null });
			}

			return new Promise((resolve) => {
				chrome.storage.local.get(
					[STORAGE_KEYS.ENABLED, STORAGE_KEYS.CONFIG, "multi_ip_slots"],
					(result) => {
						// Check storage for multi-IP mode (covers post-restart window before restoreState() runs)
						const rawSlots = result["multi_ip_slots"] as string | undefined;
						if (result[STORAGE_KEYS.ENABLED] && rawSlots) {
							try {
								const slots = JSON.parse(rawSlots) as PacSlot[];
								if (slots.length > 0) {
									resolve({ enabled: true, mode: "pac", config: null });
									return;
								}
							} catch {
								// fall through to fixed/direct check
							}
						}

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

			// Try to restore multi-IP mode first
			const rawSlots = result["multi_ip_slots"] as string | undefined;
			if (result[STORAGE_KEYS.ENABLED] && rawSlots) {
				try {
					const slots = JSON.parse(rawSlots) as PacSlot[];
					if (slots.length > 0) {
						this.enableMultiIp(slots);
						return;
					}
				} catch {
					// Preserve the original record for retry or explicit repair. A
					// malformed record or failed listener is not a user disconnect.
					throw new Error("Failed to restore saved Firefox multi-IP proxy config");
				}
			}

			// Fall back to restoring standard/fixed mode
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
