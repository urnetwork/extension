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
// The popup opens loading, showing no state until the background answers
// (reattach): never Disconnected or Connect over a proxy that may be set.
//
// A connect shows Connecting until the first health check after it ends
// (extension#27): a proxy that is set may not carry traffic yet. The
// background answers the connect once that check passed (Connected), or found
// no answer in time (Degraded), or found the account out of data. A popup
// that opens while the check runs shows Connecting, and waits for the same
// end (POPUP_CONNECT_CHECK).
//
// Not safe for concurrent use: the popup drives one instance at a time.
import { getMessage } from "./i18n";
import {
	connectCheckPending,
	proxyHealthReportWithPlan,
	parsePlan,
	type OutOfBalancePlan,
	type ProxyHealthReport,
} from "./proxy-health-report";
import {
	isControlRefusal,
	refusalOfCode,
	type ProxyControl,
	type ProxyControlRefusal,
	type ProxyView,
} from "./proxy-control";
import type { ConnectLocation } from "./sdk-types";

// - loading: the popup opened and the background has not said yet;
// - connecting: a connect is in progress, until the first health check after
//   it ends;
// - degraded: the proxy is set and does not answer, so the browser is offline
//   until it answers or a disconnect: the first check after the connect found
//   no answer in time and the checks go on, or the checks gave up and the
//   kill switch keeps it set (DegradedCause);
// - out_of_balance: the proxy is set and the account has no data left, so the
//   browser is offline until data is available or a disconnect, whatever the
//   kill switch says (utils/out-of-balance.ts);
// - blocked: another extension holds the browser's proxy setting with
//   priority, or policy fixes it, so the extension cannot connect.
export type ConnectionStatus =
	| "loading"
	| "idle"
	| "connecting"
	| "connected"
	| "degraded"
	| "out_of_balance"
	| "blocked"
	| "error";

// The out-of-data alert. held: the proxy is set and holds the browser's
// traffic; false once the user disconnected from it, which keeps the alert, so
// that ur.io's Get Pro and Buy data, which cannot load through the held proxy,
// are there to open.
export type OutOfBalanceAlert = { plan: OutOfBalancePlan; held: boolean };

// Who keeps the proxy setting from this extension, and whether the extension
// still means to be connected (its value waits under the other one's, and a
// Disconnect ends it).
export type BlockedProxy = { control: ProxyControlRefusal; intent: boolean };

// Why the proxy is Degraded: the first check after a connect found no answer
// in time, and the checks go on (unanswered); or the checks gave up and the
// kill switch keeps the proxy set (kill_switch).
export type DegradedCause = "unanswered" | "kill_switch";

export interface ConnectionManagerCallbacks {
	onStatusChange: (status: ConnectionStatus) => void;
	onProxyChange: (config: null) => void;
	// why a connect failed (the server's reason, or the popup's own message), or
	// why the checks took the proxy off; null when there is nothing to say. A
	// failure with the proxy still set (connected, degraded or out of balance)
	// is a location change that did not happen.
	onError: (message: string | null) => void;
	onOutOfBalance?: (alert: OutOfBalanceAlert | null) => void;
	onBlocked?: (blocked: BlockedProxy | null) => void;
	onDegraded?: (cause: DegradedCause | null) => void;
}

// what a connect came to: connected; failed with the install's previous proxy
// still set (kept); failed with none; refused because the extension cannot
// set the proxy (blocked); or not run (another request was in progress)
export type ConnectResult = "connected" | "kept" | "failed" | "blocked" | "skipped";

// Sends one message to the background and resolves its answer.
export type BackgroundSendFn = (message: Record<string, unknown>) => Promise<unknown>;

// health: how the first check after a connect ended (utils/proxy-health.ts
// ProxyHealthOutcome), null when none ran; an older background leaves it out
type BackgroundAnswer =
	| { success?: boolean; error?: string; code?: string; view?: Partial<ProxyView>; health?: unknown }
	| undefined;

// the proxy set by a connect that answered without a view
const OWN_VIEW: ProxyView = { enabled: true, control: "ours", intent: true };

// the proxy as the background reported it, or null when it could not say
function parseView(value: unknown): ProxyView | null {
	if (!value || typeof value !== "object") return null;
	const view = value as Partial<ProxyView>;
	const controls: ProxyControl[] = ["ours", "available", "other_extension", "policy"];
	return {
		enabled: view.enabled === true,
		control: controls.includes(view.control as ProxyControl) ? (view.control as ProxyControl) : "available",
		intent: view.intent === true,
	};
}

type HeldReport = { report: ProxyHealthReport; plan: OutOfBalancePlan | null } | null;

// the background's own connect failures (bridge/background.ts), whose English
// is not the server's: the popup says them in its own words
const OWN_FAILURE_CODES = ["incomplete_config", "not_setup"];

export class ConnectionManager {
	private status: ConnectionStatus = "loading";
	private outOfBalancePlan: OutOfBalancePlan | null = null;
	private callbacks: ConnectionManagerCallbacks;
	private send: BackgroundSendFn;
	private operationLock = false;
	private destroyed = false;
	// the background's live messages that arrive while reattach reads the kept
	// report: they are newer, so they apply after it
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
	// applies the install's client, or replaces it at a new location, and
	// answers once the first check after it ends; Connecting until then. A
	// failure shows the proxy as the background says it stands: a location
	// change that failed can leave the previous proxy set, which is still
	// connected.
	async connect(location?: ConnectLocation): Promise<ConnectResult> {
		if (this.operationLock || this.destroyed) return "skipped";
		this.operationLock = true;
		this.show("connecting");
		this.callbacks.onError(null);
		try {
			let answer: BackgroundAnswer;
			try {
				answer = (await this.send({ type: "POPUP_CONNECT", location: location ?? null })) as BackgroundAnswer;
			} catch (err) {
				answer = { success: false, error: err instanceof Error ? err.message : undefined };
			}
			if (this.destroyed) return "skipped";
			if (answer?.success) {
				if (answer.health === undefined) {
					// an older background, which answers before any check
					this.show("connected");
				} else {
					await this.showCheckEnd(answer.health, parseView(answer.view) ?? OWN_VIEW);
				}
				this.callbacks.onProxyChange(null);
				return "connected";
			}
			const view = parseView(answer?.view);
			const refusal = refusalOfCode(answer?.code) ?? (view && isControlRefusal(view.control) ? view.control : null);
			if (refusal) {
				this.showBlocked(refusal, view?.intent ?? false);
				return "blocked";
			}
			// the server's own reason when it refused (a plan limit, a rate limit);
			// the background's own failures read as the popup's translated one
			const reason =
				(!OWN_FAILURE_CODES.includes(answer?.code ?? "") && answer?.error) ||
				getMessage("extension_connect_failed");
			if (view?.enabled) {
				this.showView(view, await this.readHeldReport());
				this.callbacks.onError(reason);
				return "kept";
			}
			this.show("error");
			this.callbacks.onError(reason);
			return "failed";
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
	// the way a popup open all along shows it, and provisions nothing. `view` is
	// the proxy as GET_VPN_STATE reports it (a boolean: whether the browser is
	// set to the proxy), null when the background could not say. A proxy that
	// is set is Connected, unless the health check's last report is that it does
	// not answer, or that the account is out of balance; a proxy the check took
	// off shows why; a setting another extension or policy holds shows that. A
	// popup opened mid-outage waits for no check, but one opened during the
	// first check after a connect shows Connecting until that check ends.
	async reattach(view: ProxyView | boolean | null): Promise<void> {
		if (this.destroyed || this.operationLock || this.reportsDuringReattach) return;
		const live: unknown[] = [];
		this.reportsDuringReattach = live;
		const [report, checking] = await Promise.all([this.readHeldReport(), this.readConnectCheck()]);
		this.reportsDuringReattach = null;
		if (this.destroyed) return;
		const proxyView: ProxyView | null =
			typeof view === "boolean" ? { enabled: view, control: view ? "ours" : "available", intent: view } : view;
		// a connect, or a live report, since the popup opened is newer
		if (!this.operationLock && this.status === "loading") {
			if (checking && proxyView?.enabled && !isControlRefusal(proxyView.control)) {
				// the check's end is newer than any report that came meanwhile
				await this.awaitConnectCheck(proxyView);
				return;
			}
			this.showView(proxyView, report);
		}
		for (const message of live) {
			this.backgroundMessage(message);
		}
	}

	destroy(): void {
		this.destroyed = true;
		chrome.runtime.onMessage?.removeListener(this.onBackgroundMessage);
	}

	// ── helpers ───────────────────────────────────────────────────────────────

	private async readHeldReport(): Promise<HeldReport> {
		try {
			return await proxyHealthReportWithPlan();
		} catch {
			// unread: the proxy state alone decides
			return null;
		}
	}

	private async readConnectCheck(): Promise<boolean> {
		try {
			return await connectCheckPending();
		} catch {
			// unread: as if none ran
			return false;
		}
	}

	// Connecting, until the background answers how the first check after a
	// connect ended (background/index.ts POPUP_CONNECT_CHECK). A background that
	// cannot be asked leaves `view` and the kept report to decide.
	private async awaitConnectCheck(view: ProxyView): Promise<void> {
		this.operationLock = true;
		this.show("connecting");
		try {
			let answer: BackgroundAnswer;
			try {
				answer = (await this.send({ type: "POPUP_CONNECT_CHECK" })) as BackgroundAnswer;
			} catch {
				answer = undefined;
			}
			if (this.destroyed) return;
			await this.showCheckEnd(answer?.health, parseView(answer?.view) ?? view);
		} finally {
			this.operationLock = false;
		}
	}

	// How the first check after a connect ended: Connected when a probe passed;
	// otherwise the proxy as it stands, with the report the check kept: Degraded
	// while it does not answer yet, the out-of-data alert, or Connected when it
	// kept none (no check ran).
	private async showCheckEnd(health: unknown, view: ProxyView): Promise<void> {
		if (health === "healthy") {
			this.show("connected");
			return;
		}
		const held = await this.readHeldReport();
		if (this.destroyed) return;
		this.showView(view, held ?? (health === "unanswered" ? { report: "unanswered", plan: null } : null));
	}

	private async end(type: "POPUP_DISCONNECT" | "POPUP_END_SESSION"): Promise<void> {
		if (this.destroyed) return;
		// out of data, the alert stays without the proxy: its links load now
		const outOfBalance = this.status === "out_of_balance" ? this.outOfBalancePlan : null;
		this.operationLock = true;
		let answer: BackgroundAnswer;
		try {
			answer = (await this.send({ type })) as BackgroundAnswer;
		} catch {
			// the background tears down on its own state; nothing here to retry
		} finally {
			this.operationLock = false;
		}
		const view = parseView(answer?.view);
		if (view && isControlRefusal(view.control)) {
			this.showBlocked(view.control, view.intent);
		} else {
			this.show("idle");
		}
		this.callbacks.onError(null);
		if (outOfBalance && type === "POPUP_DISCONNECT") {
			this.callbacks.onOutOfBalance?.({ plan: outOfBalance, held: false });
		}
		this.callbacks.onProxyChange(null);
		this.destroy();
	}

	// the proxy as the background reported it, with the health check's kept report
	private showView(view: ProxyView | null, held: HeldReport): void {
		if (view && isControlRefusal(view.control)) {
			this.showBlocked(view.control, view.intent);
			return;
		}
		if (view?.enabled) {
			if (held?.report === "unreachable") {
				this.showDegraded("kill_switch");
			} else if (held?.report === "unanswered") {
				this.showDegraded("unanswered");
			} else if (held?.report === "out_of_balance") {
				this.showOutOfBalance(held.plan ?? "free");
			} else {
				this.show("connected");
			}
			return;
		}
		if (held?.report === "fell_back") {
			this.show("error");
			this.callbacks.onError(getMessage("extension_proxy_fell_back"));
			return;
		}
		this.show("idle");
	}

	private showOutOfBalance(plan: OutOfBalancePlan): void {
		this.outOfBalancePlan = plan;
		this.show("out_of_balance");
		this.callbacks.onOutOfBalance?.({ plan, held: true });
	}

	private showBlocked(control: ProxyControlRefusal, intent: boolean): void {
		this.show("blocked");
		this.callbacks.onBlocked?.({ control, intent });
	}

	private showDegraded(cause: DegradedCause): void {
		this.show("degraded");
		this.callbacks.onDegraded?.(cause);
	}

	// sets the status, and ends the alerts that belong to other statuses
	private show(status: ConnectionStatus): void {
		if (status !== "out_of_balance") {
			if (this.outOfBalancePlan !== null) this.callbacks.onOutOfBalance?.(null);
			this.outOfBalancePlan = null;
		}
		if (status !== "blocked" && this.status === "blocked") {
			this.callbacks.onBlocked?.(null);
		}
		if (status !== "degraded" && this.status === "degraded") {
			this.callbacks.onDegraded?.(null);
		}
		this.setStatus(status);
	}

	// what the background tells an open popup: the health check's reports
	// (utils/proxy-health.ts), and who holds the proxy setting when that changes
	// (background/index.ts PROXY_CONTROL)
	private backgroundMessage(message: unknown): void {
		if (this.destroyed) return;
		const { type } = (message ?? {}) as { type?: unknown };
		if (type !== "PROXY_HEALTH" && type !== "PROXY_CONTROL") return;
		if (this.reportsDuringReattach) {
			this.reportsDuringReattach.push(message);
			return;
		}
		// a connect or disconnect in progress shows its own outcome
		if (this.operationLock) return;
		if (type === "PROXY_CONTROL") {
			this.controlChanged(parseView((message as { view?: unknown }).view));
			return;
		}
		const { outcome, plan } = message as { outcome?: unknown; plan?: unknown };
		this.showReport(outcome, parsePlan(plan));
	}

	private showReport(outcome: unknown, plan: OutOfBalancePlan | null): void {
		if (outcome === "fell_back") {
			this.show("error");
			this.callbacks.onError(getMessage("extension_proxy_fell_back"));
		} else if (outcome === "unreachable") {
			this.showDegraded("kill_switch");
			this.callbacks.onError(null);
		} else if (outcome === "unanswered") {
			this.showDegraded("unanswered");
			this.callbacks.onError(null);
		} else if (outcome === "out_of_balance") {
			this.showOutOfBalance(plan ?? "free");
			this.callbacks.onError(null);
		} else if (outcome === "healthy" && (this.status === "degraded" || this.status === "out_of_balance")) {
			this.show("connected");
			this.callbacks.onError(null);
		} else if (outcome === "failing" && this.status === "out_of_balance") {
			// data is back while the proxy still fails: as any failure the checks
			// have not given up on, the proxy is set
			this.show("connected");
		}
	}

	// another extension took the proxy setting, or gave it back
	private controlChanged(view: ProxyView | null): void {
		if (!view) return;
		if (isControlRefusal(view.control)) {
			this.showBlocked(view.control, view.intent);
			this.callbacks.onError(null);
			return;
		}
		if (this.status !== "blocked") return;
		// free again: the proxy as it is now, this extension's own if it came back
		void this.readHeldReport().then((held) => {
			if (!this.destroyed && !this.operationLock && this.status === "blocked") {
				this.showView(view, held);
			}
		});
	}

	private setStatus(s: ConnectionStatus): void {
		if (this.status === s) return;
		this.status = s;
		this.callbacks.onStatusChange(s);
	}
}
