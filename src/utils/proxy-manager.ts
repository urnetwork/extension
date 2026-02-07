interface ProxyConfig {
	host: string;
	port?: number;
	scheme: "http" | "https" | "socks4" | "socks5";
	username?: string;
	password?: string;
}

interface ProxyState {
	enabled: boolean;
	config: ProxyConfig | null;
}

class ProxyManager {
	private state: ProxyState = {
		enabled: false,
		config: null,
	};

	/**
	 * Get the ACTUAL proxy state from Chrome (source of truth)
	 * This checks what Chrome is actually using, not just our internal state
	 */
	async getActualProxyState(): Promise<ProxyState> {
		return new Promise((resolve) => {
			chrome.proxy.settings.get({ incognito: false }, (config) => {
				// Check if there's an error
				if (chrome.runtime.lastError) {
					console.error("Error getting proxy state:", chrome.runtime.lastError);
					resolve({ enabled: false, config: null });
					return;
				}

				// Check the proxy mode
				const value = config.value as chrome.proxy.ProxyConfig;

				if (value.mode === "fixed_servers" && value.rules?.singleProxy) {
					const proxy = value.rules.singleProxy;

					// Reconstruct our config from Chrome's settings
					const proxyConfig: ProxyConfig = {
						host: proxy.host,
						port: proxy.port,
						scheme: proxy.scheme as "http" | "https" | "socks4" | "socks5",
					};

					// Also check our stored config for any additional data
					chrome.storage.local.get(["proxy_config"], (result) => {
						if (result.proxy_config) {
							const stored = result.proxy_config as ProxyConfig;
							proxyConfig.username = stored.username;
							proxyConfig.password = stored.password;
						}

						resolve({
							enabled: true,
							config: proxyConfig,
						});
					});
				} else {
					// Proxy is not enabled (direct mode or system mode)
					resolve({
						enabled: false,
						config: null,
					});
				}
			});
		});
	}

	/**
	 * Enable the VPN proxy with the given configuration
	 */
	async enable(config: ProxyConfig): Promise<void> {
		const proxyConfig: chrome.proxy.ProxyConfig = {
			mode: "fixed_servers",
			rules: {
				singleProxy: {
					scheme: config.scheme,
					host: config.host,
					port: config.port,
				},
				bypassList: [
					// Local addresses don't need to go through proxy
					"localhost",
					"127.0.0.1",
					"<local>",
				],
			},
		};

		return new Promise((resolve, reject) => {
			chrome.proxy.settings.set(
				{
					value: proxyConfig,
					scope: "regular",
				},
				() => {
					if (chrome.runtime.lastError) {
						reject(new Error(chrome.runtime.lastError.message));
					} else {
						this.state.enabled = true;
						this.state.config = config;

						// Store state in chrome.storage for persistence
						chrome.storage.local.set({
							proxy_enabled: true,
							proxy_config: config,
						});

						console.log("VPN proxy enabled:", config);
						resolve();
					}
				},
			);
		});
	}

	/**
	 * Disable the VPN proxy and return to direct connection
	 */
	async disable(): Promise<void> {
		return new Promise((resolve, reject) => {
			chrome.proxy.settings.set(
				{
					value: { mode: "direct" },
					scope: "regular",
				},
				() => {
					if (chrome.runtime.lastError) {
						reject(new Error(chrome.runtime.lastError.message));
					} else {
						this.state.enabled = false;
						this.state.config = null;

						// Update stored state
						chrome.storage.local.set({
							proxy_enabled: false,
							proxy_config: null,
						});

						console.log("VPN proxy disabled");
						resolve();
					}
				},
			);
		});
	}

	/**
	 * Get current proxy state (uses cached state)
	 * For real-time state, use getActualProxyState()
	 */
	getState(): ProxyState {
		return { ...this.state };
	}

	/**
	 * Restore proxy state from storage (call on extension startup)
	 */
	async restoreState(): Promise<void> {
		// First check what Chrome actually has configured
		const actualState = await this.getActualProxyState();

		if (actualState.enabled && actualState.config) {
			// Chrome already has a proxy configured, restore our internal state
			this.state = actualState;
			console.log("Restored proxy state from Chrome settings:", actualState);
		} else {
			// Check if we have saved config that needs to be reapplied
			return new Promise((resolve) => {
				chrome.storage.local.get(
					["proxy_enabled", "proxy_config"],
					(result) => {
						if (result.proxy_enabled && result.proxy_config) {
							this.enable(result.proxy_config as ProxyConfig)
								.then(() => resolve())
								.catch((error) => {
									console.error("Failed to restore proxy state:", error);
									resolve();
								});
						} else {
							resolve();
						}
					},
				);
			});
		}
	}
}

// Export singleton instance
export const proxyManager = new ProxyManager();
export type { ProxyConfig, ProxyState };
