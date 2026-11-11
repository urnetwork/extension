// Out of balance: the account has no data left, so the hosted proxy carries
// nothing (owner, 2026-11-11: the extension behaves as the apps do). The apps
// never disconnect when the balance runs out, because a disconnect the user did
// not make can leak their traffic (owner, 2026-10-02): they alert, post a local
// notification, and leave disconnecting to the user. So the extension keeps
// its proxy set, whatever the kill switch says, the popup shows when free
// data refreshes, Get Pro and Buy data on ur.io, and Disconnect, and the
// toolbar icon shows a "!" (and the browser a notification, once the user
// turned alerts on).
//
// The hosted proxy does not say why it cannot carry a request (a CONNECT it has
// no route for is answered 504 once its budget runs out, server
// proxy/server.go), and the browser shows the extension no proxy status
// anyway. So, like ur.io's Connect screen (mmm ur.io/react/src/app/connect/
// outOfData.js), the extension reads the account balance (GET
// /subscription/balance, bridge/api.ts) when a health check fails
// (utils/proxy-health.ts), with the same thresholds.
import { notificationsGranted } from "./alerts-permission";

// Below this much available data the server refuses a new contract
// (server model/subscription_model.go: a contract shrinks to fit what is
// left and is refused only below min(request, 1 MiB)), so less is out of data.
export const OUT_OF_DATA_BYTES = 1024 * 1024;

// ur.io's Get Pro (with no welcome offer it is the regular upgrade sheet) and
// its data packs. Through a proxy that holds the browser's traffic they do not
// load, so the popup says to disconnect first (insufficient_balance_disconnect_first).
export const GET_PRO_URL = "https://ur.io/app/offer";
export const BUY_DATA_URL = "https://ur.io/buy-data";

export type BalanceReading = {
	// the data left to start contracts with, in bytes (finite)
	balanceByteCount: number;
	// the account is Pro (an in-window Pro balance, or the Pro plan)
	pro: boolean;
};

/** Whether a balance reading is out of data. */
export function isOutOfData(balance: BalanceReading): boolean {
	return balance.balanceByteCount < OUT_OF_DATA_BYTES;
}

// The next free grant: the first 00:00 UTC strictly after `now` (ms). (server
// controller/subscription_controller.go grants the free data at 00:00 UTC;
// epoch time has no leap seconds, so UTC days are whole days)
const DAY_MS = 24 * 60 * 60 * 1000;
export function nextFreeRefresh(now: number): number {
	return (Math.floor(now / DAY_MS) + 1) * DAY_MS;
}

// Whole hours and minutes until the free refresh, rounded up to whole minutes
// so it never reads zero while the refresh is still ahead (the apps'
// freeRefreshCountdown).
export function freeRefreshCountdown(now: number): { hours: number; minutes: number } {
	const totalMinutes = Math.ceil((nextFreeRefresh(now) - now) / 60_000);
	return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

type GetMessage = (key: string) => string;

// a store string with its {name} placeholders filled in
export function fillPlaceholders(template: string, values: Record<string, string | number>): string {
	return template.replace(/\{(\w+)\}/g, (marker, name: string) =>
		name in values ? String(values[name]) : marker,
	);
}

// "5h 12m", or "12m" in the last hour, with the apps' duration strings
function countdownLabel(getMessage: GetMessage, now: number): string {
	const { hours, minutes } = freeRefreshCountdown(now);
	return hours > 0
		? fillPlaceholders(getMessage("provider_connected_duration_hours"), { hours, minutes })
		: fillPlaceholders(getMessage("provider_connected_duration_minutes"), { minutes });
}

/** "Free data refreshes in 5h 12m." */
export function freeRefreshLine(getMessage: GetMessage, now: number): string {
	return fillPlaceholders(getMessage("insufficient_balance_refreshes_in"), {
		time: countdownLabel(getMessage, now),
	});
}

/** The alert's title: the apps' "Insufficient balance", or for Pro "Data limit reached". */
export function outOfBalanceTitle(getMessage: GetMessage, pro: boolean): string {
	return getMessage(pro ? "data_limit_reached" : "insufficient_balance");
}

// ── the browser notification ─────────────────────────────────────────────────
// One per episode, and only where the browser lets the extension post
// notifications: the permission is optional (manifest.config.ts), and only
// the popup's Turn on alerts asks for it (utils/alerts-permission.ts). A
// required one would make the browser warn on update and disable the
// extension until the user accepts, which takes its proxy setting away
// meanwhile. Without it, the popup's alert and the toolbar badge (below) are
// the alert.

export const OUT_OF_DATA_NOTIFICATION_ID = "urnetwork-out-of-data";

async function mayNotify(): Promise<boolean> {
	if (!chrome.notifications?.create) return false;
	return notificationsGranted();
}

/**
 * Posts the episode's notification if the browser allows it. Resolves whether
 * it was posted.
 */
export async function postOutOfDataNotification(
	getMessage: GetMessage,
	pro: boolean,
	now: number,
): Promise<boolean> {
	if (!(await mayNotify())) return false;
	const held = getMessage("extension_out_of_data_held");
	try {
		await chrome.notifications.create(OUT_OF_DATA_NOTIFICATION_ID, {
			type: "basic",
			iconUrl: chrome.runtime.getURL("logo.png"),
			title: outOfBalanceTitle(getMessage, pro),
			message: pro ? held : `${freeRefreshLine(getMessage, now)} ${held}`,
		});
		return true;
	} catch {
		return false;
	}
}

/** Takes the episode's notification down: data is back, or the user acted. */
export async function clearOutOfDataNotification(): Promise<void> {
	if (!chrome.notifications?.clear) return;
	try {
		await chrome.notifications.clear(OUT_OF_DATA_NOTIFICATION_ID);
	} catch {
		// nothing posted, or the permission went
	}
}

// ── the toolbar badge ────────────────────────────────────────────────────────
// A "!" on the extension's toolbar icon for as long as the episode lasts. It
// needs no permission, so with the popup closed it is the alert wherever the
// browser shows the extension no notifications, and it stays beside the
// notification where it does. In the colors of the popup's alert.

export const OUT_OF_DATA_BADGE_TEXT = "!";
// --ur-color-yellow-light and --ur-color-black (elements/src/index.css)
const OUT_OF_DATA_BADGE_COLOR = "#eff7bb";
const OUT_OF_DATA_BADGE_TEXT_COLOR = "#101010";

/** Shows the episode's badge. */
export async function showOutOfDataBadge(): Promise<void> {
	if (!chrome.action?.setBadgeText) return;
	try {
		await chrome.action.setBadgeBackgroundColor({ color: OUT_OF_DATA_BADGE_COLOR });
		await chrome.action.setBadgeTextColor?.({ color: OUT_OF_DATA_BADGE_TEXT_COLOR });
		await chrome.action.setBadgeText({ text: OUT_OF_DATA_BADGE_TEXT });
	} catch {
		// no toolbar icon to badge: the popup still shows the alert
	}
}

/** Takes the badge off: the episode is over. */
export async function clearOutOfDataBadge(): Promise<void> {
	if (!chrome.action?.setBadgeText) return;
	try {
		await chrome.action.setBadgeText({ text: "" });
	} catch {
		// nothing to take off
	}
}
