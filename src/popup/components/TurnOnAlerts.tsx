import React from "react";
import { getMessage } from "@/utils/i18n";

// Turn on alerts: asks the browser to let the extension show its out-of-data
// notification (utils/alerts-permission.ts), the one place the extension asks
// for it. The connect screen shows it while the browser can be asked and has
// not granted it: in the out-of-data alert beside its links, or else under the
// settings toggles with what it is for. Styled as the alert's links are.
export const TurnOnAlertsButton: React.FC<{ onClick: () => void; requesting: boolean }> = ({
	onClick,
	requesting,
}) => (
	<button
		type="button"
		onClick={onClick}
		disabled={requesting}
		aria-busy={requesting ? true : undefined}
		data-testid="turn-on-alerts"
		className="cursor-pointer text-left text-xs font-medium underline disabled:cursor-not-allowed disabled:opacity-50"
		style={{ color: "var(--ur-color-blue-electric, #4a9eff)", background: "none", border: "none", padding: 0 }}
	>
		{getMessage("extension_turn_on_alerts")}
	</button>
);

export default TurnOnAlertsButton;
