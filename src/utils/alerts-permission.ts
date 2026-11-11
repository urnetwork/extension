// The out-of-data notification (utils/out-of-balance.ts) needs the browser's
// notifications permission, which the manifest makes optional
// (manifest.config.ts): a new required permission makes the browser disable
// the extension on update until the user accepts it, and its proxy setting
// goes with it. The owner chose (2026-11-11, "accept recommendation a") a
// button in the popup that asks for it instead: Turn on alerts
// (popup/components/TurnOnAlerts.tsx). Nothing else ever asks. Until the user
// grants it, and after they refuse it or take it back, the out-of-data alert
// is the popup's and the toolbar badge's (utils/out-of-balance.ts).

const NOTIFICATIONS: chrome.permissions.Permissions = { permissions: ["notifications"] };

/**
 * Whether this browser can be asked for the permission: the manifest offers
 * it as optional, and the permissions API can ask for it.
 */
export function notificationsRequestable(): boolean {
	if (typeof chrome.permissions?.request !== "function") return false;
	try {
		const optional: string[] = chrome.runtime.getManifest().optional_permissions ?? [];
		return optional.includes("notifications");
	} catch {
		return false;
	}
}

/** Whether the extension may show notifications now. */
export async function notificationsGranted(): Promise<boolean> {
	if (typeof chrome.permissions?.contains !== "function") return false;
	try {
		return (await chrome.permissions.contains(NOTIFICATIONS)) === true;
	} catch {
		return false;
	}
}

/**
 * Asks the browser for the permission, and resolves whether it was granted.
 * Call it in the click itself, with nothing awaited before it: Firefox grants
 * a request only from inside a user input handler, and Chrome only while the
 * click's user activation lasts. The popup can close while the browser asks
 * (the prompt takes its focus), so what a grant does is not left to this
 * promise: the background acts on permissions.onAdded (background/index.ts),
 * and an open popup follows it (watchNotificationsPermission).
 */
export function requestNotifications(): Promise<boolean> {
	try {
		return chrome.permissions.request(NOTIFICATIONS).then(
			(granted) => granted === true,
			() => false,
		);
	} catch {
		return Promise.resolve(false);
	}
}

/** Whether a permissions.onAdded or onRemoved event is about notifications. */
export function concernsNotifications(permissions: chrome.permissions.Permissions | undefined): boolean {
	return permissions?.permissions?.includes("notifications") === true;
}

/**
 * Follows the permission: onChange is told whether it is granted once that is
 * read, and again each time the user grants it or takes it back (Firefox's
 * add-on settings can remove it at any time). Returns the unsubscribe.
 */
export function watchNotificationsPermission(onChange: (granted: boolean) => void): () => void {
	let stopped = false;
	// a grant or a removal while the first read is out is newer than its answer
	let changed = false;
	const follow = (granted: boolean) => (permissions: chrome.permissions.Permissions) => {
		if (stopped || !concernsNotifications(permissions)) return;
		changed = true;
		onChange(granted);
	};
	const onAdded = follow(true);
	const onRemoved = follow(false);
	chrome.permissions?.onAdded?.addListener(onAdded);
	chrome.permissions?.onRemoved?.addListener(onRemoved);
	void notificationsGranted().then((granted) => {
		if (!stopped && !changed) onChange(granted);
	});
	return () => {
		stopped = true;
		chrome.permissions?.onAdded?.removeListener(onAdded);
		chrome.permissions?.onRemoved?.removeListener(onRemoved);
	};
}
