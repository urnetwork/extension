import type { ConnectLocation, AuthNetworkClientArgs } from "node_modules/@urnetwork/sdk-js/dist/generated";
import { parseByJwtClientId } from "@urnetwork/sdk-js/react";
import type { ProxyConfig } from "./proxy-manager";
import { buildPacScript, pacScriptToDataUrl, type PacSlot } from "./pac-script";
import { chromeStorageAdapter } from "./storage-adapter";
import { getKillSwitch } from "./kill-switch";

const MULTI_IP_SLOTS_KEY = "multi_ip_slots";

export type ConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "degraded"
	| "reconnecting"
	| "error";

export type ConnectionMode = "standard" | "multi-ip";

export interface ConnectionManagerCallbacks {
	onStatusChange: (status: ConnectionStatus) => void;
	onProxyChange: (config: ProxyConfig | null) => void;
	onError: (message: string | null) => void;
}

type AuthNetworkClientFn = (args: AuthNetworkClientArgs) => Promise<{
	by_client_jwt?: string;
	proxy_config_result: {
		auth_token?: string;
		proxy_host?: string;
		https_proxy_port?: number;
		expiration_time: string;
		keepalive_seconds: number;
	} | null;
	error?: { message: string; client_limit_exceeded: boolean } | null;
}>;

type RemoveNetworkClientFn = (clientId: string) => Promise<{ error?: unknown }>;

// Standard mode storage key (singular — matches legacy key used by proxy-manager restore)
const STORAGE_KEY_CLIENT_ID = "proxy_client_id";
// Multi-IP mode storage key for the provisioned slot client IDs
const STORAGE_KEY_MULTI_CLIENT_IDS = "multi_ip_client_ids";

const PING_URL = "https://api-v4.bringyour.com/my-ip-info";
const PING_TIMEOUT_MS = 5_000;
const PING_RATE_LIMIT_MS = 500;
const FALLBACK_KEEPALIVE_S = 30;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const STARTUP_GRACE_MS = 12_000;
const PING_FAILURES_FOR_DEGRADED = 2;
const PING_FAILURES_FOR_RECONNECT = 3;
const MIN_CONNECTED_MS = 15_000;

// Shared rate-limit timestamp for PING_URL across all ConnectionManager instances
let lastPingAt = 0;

// Multi-IP provisioning constants
const MULTI_IP_POOL_SIZE = 5;
const MULTI_IP_STAGGER_MS = 200;
// In multi-IP/PAC mode Chrome handles proxy fallback internally — we use a
// very long ping interval so we don't churn the PAC script and break active
// connections. Health is verified at reconnect time, not continuously.
const MULTI_IP_PING_INTERVAL_S = 300; // 5 minutes

function isFirefox(): boolean {
	return Boolean((globalThis as any).browser?.proxy?.onRequest);
}

function buildAuthParams(location?: ConnectLocation): AuthNetworkClientArgs {
	const locationConfig = location
		? {
				connect_location_id: {
					location_id: location.connect_location_id?.location_id,
				},
				stable: true,
				strong_privacy: true,
			}
		: {
				connect_location_id: { best_available: true },
				stable: true,
				strong_privacy: true,
			};

	return {
		description: "",
		device_spec: "",
		proxy_config: {
			lock_caller_ip: false,
			lock_ip_list: [],
			enable_socks: true,
			enable_http: true,
			http_require_auth: false,
			initial_device_state: {
				location: locationConfig,
				performance_profile: null,
			},
		},
	};
}

export class ConnectionManager {
	private status: ConnectionStatus = "idle";
	private mode: ConnectionMode = "standard";
	private location: ConnectLocation | undefined;
	private authNetworkClient: AuthNetworkClientFn;
	private removeNetworkClient: RemoveNetworkClientFn;
	private callbacks: ConnectionManagerCallbacks;

	private pingIntervalId: ReturnType<typeof setInterval> | null = null;
	private renewTimeoutId: ReturnType<typeof setTimeout> | null = null;
	private operationLock = false;
	private consecutivePingFailures = 0;
	private reconnectAttempts = 0;
	private destroyed = false;
	private connectedAt = 0;

	// Standard mode: single client ID
	private clientId: string | null = null;
	// Multi-IP mode: all provisioned slot client IDs
	private multiClientIds: string[] = [];

	constructor(
		authNetworkClient: AuthNetworkClientFn,
		removeNetworkClient: RemoveNetworkClientFn,
		callbacks: ConnectionManagerCallbacks,
	) {
		this.authNetworkClient = authNetworkClient;
		this.removeNetworkClient = removeNetworkClient;
		this.callbacks = callbacks;
	}

	getStatus(): ConnectionStatus {
		return this.status;
	}

	getMode(): ConnectionMode {
		return this.mode;
	}

	// ── public API ─────────────────────────────────────────────────────────────

	async connect(location?: ConnectLocation, mode: ConnectionMode = "standard"): Promise<void> {
		if (this.operationLock) return;
		this.operationLock = true;
		this.location = location;
		this.mode = mode;
		this.reconnectAttempts = 0;

		this.setStatus("connecting");
		this.callbacks.onError(null);
		this.clearTimers();

		try {
			if (mode === "multi-ip") {
				await this.establishMultiIpConnection(location);
			} else {
				await this.establishConnection(location);
			}
		} finally {
			if (!this.destroyed) this.operationLock = false;
		}
	}

	async disconnect(): Promise<void> {
		if (this.destroyed) return;
		this.destroyed = true;
		this.operationLock = true;
		this.clearTimers();

		try {
			if (this.mode === "multi-ip") {
				const disableType = isFirefox() ? "DISABLE_FIREFOX_MULTI_IP" : "DISABLE_TAB_ISOLATION_PAC";
				await chrome.runtime.sendMessage({ type: disableType });
				await this.releaseMultiClientIds(this.multiClientIds);
				this.multiClientIds = [];
				await chromeStorageAdapter.removeItem(STORAGE_KEY_MULTI_CLIENT_IDS);
				await chrome.storage.local.remove(MULTI_IP_SLOTS_KEY);
			} else {
				await chrome.runtime.sendMessage({ type: "DISABLE_VPN" });
				if (this.clientId) {
					try {
						await this.removeNetworkClient(this.clientId);
					} catch {
						// best-effort
					}
					this.clientId = null;
					await chromeStorageAdapter.removeItem(STORAGE_KEY_CLIENT_ID);
				}
			}
		} catch {
			// best-effort
		}

		this.setStatus("idle");
		this.callbacks.onProxyChange(null);
	}

	/**
	 * Take ownership of an already-active proxy session restored from Chrome storage.
	 * Skips re-authenticating; starts the appropriate health loop immediately.
	 */
	reattach(location?: ConnectLocation, mode: ConnectionMode = "standard"): void {
		if (this.destroyed) return;
		this.location = location;
		this.mode = mode;
		this.reconnectAttempts = 0;
		this.consecutivePingFailures = 0;
		this.connectedAt = Date.now();
		this.clearTimers();
		this.setStatus("connected");

		const intervalS = mode === "multi-ip" ? MULTI_IP_PING_INTERVAL_S : FALLBACK_KEEPALIVE_S;
		this.pingIntervalId = setInterval(() => this.healthPing(), intervalS * 1_000);
	}

	destroy(): void {
		this.destroyed = true;
		this.clearTimers();
	}

	// ── standard connection ───────────────────────────────────────────────────

	private async establishConnection(location?: ConnectLocation): Promise<void> {
		const result = await this.authNetworkClient(buildAuthParams(location));

		if (this.destroyed) return;

		if (result.error) {
			this.setStatus("error");
			this.callbacks.onError(result.error.message);
			return;
		}

		if (!result.by_client_jwt) {
			this.setStatus("error");
			this.callbacks.onError("Authentication failed: no client token received");
			return;
		}

		const pr = result.proxy_config_result;

		if (!pr?.auth_token || !pr.proxy_host || !pr.https_proxy_port) {
			this.setStatus("error");
			this.callbacks.onError("Incomplete proxy configuration received");
			return;
		}

		const config: ProxyConfig = {
			host: `${pr.auth_token}.${pr.proxy_host}`,
			port: pr.https_proxy_port,
			scheme: "https",
		};

		const isRenewal = this.status === "connected" || this.status === "degraded" || this.status === "reconnecting";
		const msgType = isRenewal ? "SWAP_PROXY" : "ENABLE_VPN";

		const response = await chrome.runtime.sendMessage({ type: msgType, config });

		if (this.destroyed) return;

		if (!response?.success) {
			this.setStatus("error");
			this.callbacks.onError(response?.error ?? "Failed to apply proxy settings");
			return;
		}

		const newClientId = parseByJwtClientId(result.by_client_jwt);

		// Release the old client only if it's being replaced
		if (this.clientId && this.clientId !== newClientId) {
			this.removeNetworkClient(this.clientId).catch(() => {});
		}
		this.clientId = newClientId;
		await chromeStorageAdapter.setItem(STORAGE_KEY_CLIENT_ID, newClientId);

		this.callbacks.onProxyChange(config);

		// Schedule proactive renewal at 80% of remaining lifetime
		const expiresAt = new Date(pr.expiration_time).getTime();
		const lifetime = expiresAt - Date.now();
		if (lifetime > 0) {
			const renewIn = Math.floor(lifetime * 0.8);
			this.renewTimeoutId = setTimeout(() => this.silentRenew(), renewIn);
		}

		const pingIntervalMs = (pr.keepalive_seconds ?? FALLBACK_KEEPALIVE_S) * 1_000;
		this.clearPingInterval();
		this.pingIntervalId = setInterval(() => this.healthPing(), pingIntervalMs);

		this.setStatus("connected");
		this.consecutivePingFailures = 0;
		this.reconnectAttempts = 0;
		this.connectedAt = Date.now();
	}

	// ── multi-IP connection ───────────────────────────────────────────────────

	private async establishMultiIpConnection(location?: ConnectLocation): Promise<void> {
		const slots: Array<{ clientId: string; slot: PacSlot; expirationTime: string }> = [];

		for (let i = 0; i < MULTI_IP_POOL_SIZE; i++) {
			if (this.destroyed) return;
			if (i > 0) await new Promise((r) => setTimeout(r, MULTI_IP_STAGGER_MS));

			try {
				const result = await this.authNetworkClient(buildAuthParams(location));
				if (result.error || !result.by_client_jwt) continue;
				const pr = result.proxy_config_result;
				if (!pr?.auth_token || !pr.proxy_host || !pr.https_proxy_port) continue;

				const host = `${pr.auth_token}.${pr.proxy_host}`;
				if (slots.some((s) => s.slot.host === host)) continue;

				slots.push({
					clientId: parseByJwtClientId(result.by_client_jwt),
					slot: { host, port: pr.https_proxy_port },
					expirationTime: pr.expiration_time,
				});
			} catch {
				// partial pool is still usable
			}
		}

		if (this.destroyed) return;

		if (slots.length === 0) {
			this.setStatus("error");
			this.callbacks.onError("Failed to provision any proxy connections. Check your account.");
			return;
		}

		let response: { success?: boolean; error?: string };
		const slotList = slots.map((s) => s.slot);

		if (isFirefox()) {
			response = await chrome.runtime.sendMessage({
				type: "ENABLE_FIREFOX_MULTI_IP",
				slots: slotList,
			});
		} else {
			const killSwitch = await getKillSwitch();
			const pacScript = buildPacScript(slotList, { killSwitch });
			const dataUrl = pacScriptToDataUrl(pacScript);
			response = await chrome.runtime.sendMessage({
				type: "ENABLE_TAB_ISOLATION_PAC",
				dataUrl,
			});
		}

		// Store slots so the background health check can access them
		await chrome.storage.local.set({ [MULTI_IP_SLOTS_KEY]: JSON.stringify(slotList) });

		if (this.destroyed) return;

		if (!response?.success) {
			this.setStatus("error");
			this.callbacks.onError(response?.error ?? "Failed to apply multi-IP proxy settings");
			await this.releaseMultiClientIds(slots.map((s) => s.clientId));
			return;
		}

		// Release previous slots, store new ones
		await this.releaseMultiClientIds(this.multiClientIds);
		this.multiClientIds = slots.map((s) => s.clientId);
		await chromeStorageAdapter.setItem(
			STORAGE_KEY_MULTI_CLIENT_IDS,
			JSON.stringify(this.multiClientIds),
		);

		this.setStatus("connected");
		this.consecutivePingFailures = 0;
		this.reconnectAttempts = 0;
		this.connectedAt = Date.now();

		// Signal no single proxy config (PAC mode)
		this.callbacks.onProxyChange(null);

		// Schedule renewal based on actual expiry from first slot.
		// In PAC mode we re-provision all slots at renewal time to get fresh credentials.
		const expiresAt = new Date(slots[0].expirationTime).getTime();
		const lifetime = expiresAt - Date.now();
		if (lifetime > 0) {
			const renewIn = Math.floor(lifetime * 0.8);
			this.renewTimeoutId = setTimeout(() => this.silentRenewMultiIp(), renewIn);
		}

		// Use a very long ping interval in PAC mode — Chrome handles proxy fallback
		// internally. Aggressive pinging churns the PAC script and breaks active
		// page loads. We only ping here to detect a total loss of connectivity.
		this.clearPingInterval();
		this.pingIntervalId = setInterval(
			() => this.healthPing(),
			MULTI_IP_PING_INTERVAL_S * 1_000,
		);
	}

	// ── silent renewal ────────────────────────────────────────────────────────

	private async silentRenew(): Promise<void> {
		if (this.destroyed || this.operationLock) return;
		this.operationLock = true;
		try {
			this.clearPingInterval();
			await this.establishConnection(this.location);
		} finally {
			if (!this.destroyed) this.operationLock = false;
		}
	}

	// Re-provision all PAC slots with fresh credentials without tearing down Chrome's
	// current proxy setting — apply the new PAC script atomically over the old one.
	private async silentRenewMultiIp(): Promise<void> {
		if (this.destroyed || this.operationLock) return;
		this.operationLock = true;
		try {
			this.clearPingInterval();
			await this.establishMultiIpConnection(this.location);
		} finally {
			if (!this.destroyed) this.operationLock = false;
		}
	}

	// ── reconnect on failure ──────────────────────────────────────────────────

	private scheduleReconnect(): void {
		if (this.destroyed || this.operationLock) return;
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			this.setStatus("error");
			this.callbacks.onError("Connection lost. Please reconnect.");
			this.clearTimers();
			return;
		}

		this.setStatus("reconnecting");
		this.clearTimers();

		const delay = RECONNECT_DELAYS_MS[this.reconnectAttempts] ?? 30_000;
		this.reconnectAttempts++;

		this.renewTimeoutId = setTimeout(async () => {
			if (this.destroyed || this.operationLock) return;
			this.operationLock = true;
			try {
				if (this.mode === "multi-ip") {
					await this.establishMultiIpConnection(this.location);
				} else {
					await this.establishConnection(this.location);
				}
			} finally {
				if (!this.destroyed) this.operationLock = false;
			}
		}, delay);
	}

	// ── health ping ───────────────────────────────────────────────────────────

	private async healthPing(): Promise<void> {
		if (this.destroyed || this.operationLock) return;

		const now = Date.now();
		if (now - lastPingAt < PING_RATE_LIMIT_MS) return;
		lastPingAt = now;
		const age = now - this.connectedAt;
		const inGrace = age < STARTUP_GRACE_MS;

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);

		try {
			const res = await fetch(PING_URL, { signal: controller.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);

			this.consecutivePingFailures = 0;

			if (this.status === "degraded") {
				this.setStatus("connected");
			}
		} catch {
			if (inGrace) return;

			this.consecutivePingFailures++;
			const tooNew = age < MIN_CONNECTED_MS;

			if (!tooNew && this.consecutivePingFailures >= PING_FAILURES_FOR_RECONNECT) {
				this.scheduleReconnect();
			} else if (
				this.consecutivePingFailures >= PING_FAILURES_FOR_DEGRADED &&
				this.status === "connected"
			) {
				this.setStatus("degraded");
			}
		} finally {
			clearTimeout(timeoutId);
		}
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	private setStatus(s: ConnectionStatus): void {
		if (this.status === s) return;
		this.status = s;
		this.callbacks.onStatusChange(s);
	}

	private async releaseMultiClientIds(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		await Promise.allSettled(ids.map((id) => this.removeNetworkClient(id).catch(() => {})));
	}

	private clearPingInterval(): void {
		if (this.pingIntervalId !== null) {
			clearInterval(this.pingIntervalId);
			this.pingIntervalId = null;
		}
	}

	private clearTimers(): void {
		this.clearPingInterval();
		if (this.renewTimeoutId !== null) {
			clearTimeout(this.renewTimeoutId);
			this.renewTimeoutId = null;
		}
	}
}
