import { useCallback, useEffect, useState } from "react";
import {
	notificationsRequestable,
	requestNotifications,
	watchNotificationsPermission,
} from "./alerts-permission";

// The popup's view of the out-of-data notification's permission
// (utils/alerts-permission.ts):
// - unavailable: this browser cannot be asked for it;
// - unread: not read yet, so the popup offers nothing yet;
// - granted, or not_granted: the popup offers Turn on alerts.
export type AlertsPermission = "unavailable" | "unread" | "granted" | "not_granted";

interface UseAlertsPermissionResult {
	permission: AlertsPermission;
	// a request is out: the browser is asking the user
	requesting: boolean;
	// Turn on alerts: call it from the click itself
	turnOn: () => void;
}

export function useAlertsPermission(): UseAlertsPermissionResult {
	const [requestable] = useState(notificationsRequestable);
	// null until read; then it follows a grant or a removal while the popup is open
	const [granted, setGranted] = useState<boolean | null>(null);
	const [requesting, setRequesting] = useState(false);

	useEffect(() => {
		if (!requestable) return;
		return watchNotificationsPermission(setGranted);
	}, [requestable]);

	const turnOn = useCallback(() => {
		if (!requestable || requesting) return;
		setRequesting(true);
		// the request goes out now, inside the click; nothing is awaited before it
		void requestNotifications().then((grantedNow) => {
			setRequesting(false);
			if (grantedNow) setGranted(true);
		});
	}, [requestable, requesting]);

	const permission: AlertsPermission = !requestable
		? "unavailable"
		: granted === null
			? "unread"
			: granted
				? "granted"
				: "not_granted";

	return { permission, requesting, turnOn };
}
