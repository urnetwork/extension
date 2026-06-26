import React from "react";
import type { IpInfo } from "@/utils/ip-info";

interface IpInfoBannerProps {
	ipInfo: IpInfo | null;
	loading: boolean;
	error: boolean;
}

export const IpInfoBanner: React.FC<IpInfoBannerProps> = ({
	ipInfo,
	loading,
	error,
}) => {
	const locationParts = ipInfo
		? [ipInfo.city, ipInfo.region, ipInfo.countryCode].filter(Boolean).join(", ")
		: null;

	return (
		<div
			className="flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] min-h-[28px]"
			style={{ background: "var(--color-surface-2)" }}
		>
			{loading && !ipInfo ? (
				<span className="opacity-50 animate-pulse">Checking IP...</span>
			) : error && !ipInfo ? (
				<span className="opacity-40">IP unavailable</span>
			) : ipInfo ? (
				<>
					<span
						className="shrink-0 size-1.5 rounded-full"
						style={{
							backgroundColor: ipInfo.connectedToNetwork
								? "var(--ur-color-green, #22c55e)"
								: "var(--ur-color-gray)",
						}}
					/>
					<div className="flex flex-col min-w-0 gap-0.5">
						<span className="font-mono opacity-70 truncate">{ipInfo.ip}</span>
						{locationParts && (
							<span className="opacity-50 truncate">{locationParts}</span>
						)}
					</div>
				</>
			) : null}
		</div>
	);
};
