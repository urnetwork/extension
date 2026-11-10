// The popup's view of the connection. The background owns the connection
// (bridge/background.ts): the install's one hosted proxy client, applied to the
// browser as its one proxy, and the health check that keeps watching it while
// the popup is closed (utils/proxy-health.ts). Connect, disconnect and logout
// are requests to the background (background/index.ts POPUP_*); this object
// shows their outcome, and what the health check reports: what it last
// reported when the popup opens (utils/proxy-health-report.ts), and each
// report while the popup is open. It provisions nothing itself, so a closed
// popup leaves no client behind, and nothing in it reconnects.
//
// Not safe for concurrent use: the popup drives one instance at a time.
import { proxyHealthReport, type ProxyHealthReport } from "./proxy-health-report";
import type { ConnectLocation } from "./sdk-types";

// degraded: the proxy is set, failed its health checks, and the kill switch
// keeps it set, so the browser is offline until it answers or a disconnect
export type ConnectionStatus =
	| "idle"
	| "connecting"
	| "connected"
	| "degraded"
	| "error";

export interface ConnectionManagerCallbacks {
	onStatusChange: (status: ConnectionStatus) => void;
	onProxyChange: (config: null) => void;
	onError: (message: string | null) => void;
}

// Sends one message to the background and resolves its answer.
export type BackgroundSendFn = (message: Record<string, unknown>) => Promise<unknown>;

type BackgroundAnswer = { success?: boolean; error?: string; code?: string } | undefined;

const CONNECT_FAILED_MESSAGE = "Failed to connect. Check your account.";
const FELL_BACK_MESSAGE =
	"The proxy stopped answering, so the browser went back to a direct connection. Connect to try again.";
const UNREACHABLE_MESSAGE =
	"The proxy is not answering. The kill switch keeps the browser offline until it does.";

export class ConnectionManager {
	private status: ConnectionStatus = "idle";
	private callbacks: ConnectionManagerCallbacks;
	private send: BackgroundSendFn;
	private operationLock = false;
	private destroyed = false;
	// the health check's live reports that arrive while reattach reads the
	// kept one: they are newer, so they apply after it
	private reportsDuringReattach: unknown[] | null = null;
	private readonly onBackgroundMessage = (message: unknown): void => {
		this.backgroundMessage(message);
	};

	constructor(
		callbacks: ConnectionManagerCallbacks,
		send: BackgroundSendFn = (message) => chrome.runtime.sendMessage(message),
	) {
		this.callbacks = callbacks;
		this.send = send;
		chrome.runtime.onMessage?.addListener(this.onBackgroundMessage);
	}

	getStatus(): ConnectionStatus {
		return this.status;
	}

	// ── public API ─────────────────────────────────────────────────────────────

	// Connects at `location` (best available without one): the background
	// applies the install's client, or replaces it at a new location.
	async connect(location?: ConnectLocation): Promise<void> {
		if (this.operationLock || this.destroyed) return;
		this.operationLock = true;
		this.setStatus("connecting");
		this.callbacks.onError(null);
		try {
			let answer: BackgroundAnswer;
			try {
				answer = (await this.send({ type: "POPUP_CONNECT", location: location ?? null })) as BackgroundAnswer;
			} catch (err) {
				answer = { success: false, error: err instanceof Error ? err.message : undefined };
			}
			if (this.destroyed) return;
			if (answer?.success) {
				this.setStatus("connected");
				this.callbacks.onProxyChange(null);
				return;
			}
			// the server's own reason when it refused (a plan limit, a rate limit)
			this.setStatus("error");
			this.callbacks.onError(answer?.error || CONNECT_FAILED_MESSAGE);
		} finally {
			this.operationLock = false;
		}
	}

	// Takes the proxy off; the install's client stays for the next connect.
	async disconnect(): Promise<void> {
		await this.end("POPUP_DISCONNECT");
	}

	// Logout: takes the proxy off and removes the install's client.
	async endSession(): Promise<void> {
		await this.end("POPUP_END_SESSION");
	}

	// The popup opened: shows the connection as the background last saw it,
	// the way a popup open all along shows it, and provisions nothing.
	// `proxyEnabled` is whether the browser is set to the proxy (GET_VPN_STATE).
	// A proxy that is set is Connected, unless the health check's last report
	// is that it does not answer and the kill switch keeps it set; a proxy the
	// check took off shows why. A popup opened mid-outage waits for no check.
	async reattach(proxyEnabled: boolean): Promise<void> {
		if (this.destroyed || this.operationLock || this.reportsDuringReattach) return;
		const live: unknown[] = [];
		this.reportsDuringReattach = live;
		let report: ProxyHealthReport | null = null;
		try {
			report = await proxyHealthReport();
		} catch {
			// unread: the proxy state alone decides
		}
		this.reportsDuringReattach = null;
		if (this.destroyed) return;
		// a connect, or a live report, since the popup opened is newer
		if (!this.operationLock && this.status === "idle") {
			if (proxyEnabled) {
				if (report === "unreachable") {
					this.showReport("unreachable");
				} else {
					this.setStatus("connected");
				}
			} else if (report === "fell_back") {
				this.showReport("fell_back");
			}
		}
		for (const outcome of live) {
			this.showReport(outcome);
		}
	}

	destroy(): void {
		this.destroyed = true;
		chrome.runtime.onMessage?.removeListener(this.onBackgroundMessage);
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	private async end(type: "POPUP_DISCONNECT" | "POPUP_END_SESSION"): Promise<void> {
		if (this.destroyed) return;
		this.operationLock = true;
		try {
			await this.send({ type });
		} catch {
			// the background tears down on its own state; nothing here to retry
		} finally {
			this.operationLock = false;
		}
		this.setStatus("idle");
		this.callbacks.onError(null);
		this.callbacks.onProxyChange(null);
		this.destroy();
	}

	// what the health check reports (utils/proxy-health.ts)
	private backgroundMessage(message: unknown): void {
		if (this.destroyed) return;
		const { type, outcome } = (message ?? {}) as { type?: unknown; outcome?: unknown };
		if (type !== "PROXY_HEALTH") return;
		if (this.reportsDuringReattach) {
			this.reportsDuringReattach.push(outcome);
			return;
		}
		this.showReport(outcome);
	}

	private showReport(outcome: unknown): void {
		if (outcome === "fell_back") {
			this.setStatus("error");
			this.callbacks.onError(FELL_BACK_MESSAGE);
		} else if (outcome === "unreachable") {
			this.setStatus("degraded");
			this.callbacks.onError(UNREACHABLE_MESSAGE);
		} else if (outcome === "healthy" && this.status === "degraded") {
			this.setStatus("connected");
			this.callbacks.onError(null);
		}
	}

	private setStatus(s: ConnectionStatus): void {
		if (this.status === s) return;
		this.status = s;
		this.callbacks.onStatusChange(s);
	}
}
