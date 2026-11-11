import React, { useEffect, useState } from "react";
import { getMessage } from "@/utils/i18n";
import type { OutOfBalanceAlert } from "@/utils/connection-manager";
import { BUY_DATA_URL, GET_PRO_URL, freeRefreshLine, outOfBalanceTitle } from "@/utils/out-of-balance";

// The popup's out-of-data alert (utils/out-of-balance.ts), the extension's port
// of the apps' out-of-balance block and ur.io's Connect notice: the account has
// no data left. It says when the free data refreshes (Pro: when its data
// renews), what this browser does meanwhile, and the way forward on ur.io: Get
// Pro and Buy data (Pro, which is never offered an upgrade: Buy data). It never
// disconnects: Disconnect stays the button above it. While the proxy holds the
// traffic, ur.io cannot load through it, so the alert says to disconnect
// first; after a Disconnect it stays, with its links, until the popup closes.

// the time now, a minute at a time, for the refresh countdown
function useMinuteClock(): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(interval);
	}, []);
	return now;
}

export const OutOfDataNotice: React.FC<{ alert: OutOfBalanceAlert }> = ({ alert }) => {
	const now = useMinuteClock();
	const pro = alert.plan === "pro";
	const linkClass = "text-xs font-medium underline";

	return (
		<div
			className="mt-2 flex flex-col gap-1"
			data-testid="out-of-data-notice"
			data-out-of-data-plan={alert.plan}
			data-out-of-data-held={alert.held ? "true" : "false"}
		>
			<span className="text-xs font-semibold" role="alert" style={{ color: "var(--ur-color-yellow-light)" }}>
				{outOfBalanceTitle(getMessage, pro)}
			</span>
			<span className="text-xs">
				{pro ? getMessage("site_data_limit_pro") : freeRefreshLine(getMessage, now)}
			</span>
			{alert.held && (
				<>
					<span className="text-xs opacity-80">{getMessage("extension_out_of_data_held")}</span>
					<span className="text-xs opacity-80">
						{getMessage(pro ? "extension_data_limit_disconnect_first" : "insufficient_balance_disconnect_first")}
					</span>
				</>
			)}
			<div className="mt-1 flex items-center gap-3">
				{!pro && (
					<a className={linkClass} href={GET_PRO_URL} target="_blank" rel="noopener noreferrer">
						{getMessage("get_pro")}
					</a>
				)}
				<a className={linkClass} href={BUY_DATA_URL} target="_blank" rel="noopener noreferrer">
					{getMessage("extension_buy_data")}
				</a>
			</div>
		</div>
	);
};

export default OutOfDataNotice;
