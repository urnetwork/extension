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
		<div className="flex items-center justify-between px-ur-sm py-1 mb-ur-sm rounded bg-(--ur-color-gray-dark)/30 text-xs min-h-[24px]">
			{loading && !ipInfo ? (
				<span className="text-(--ur-color-gray) animate-pulse">
					Checking your IP...
				</span>
			) : error && !ipInfo ? (
				<span className="text-(--ur-color-gray)">IP unavailable</span>
			) : ipInfo ? (
				<>
					<div className="flex items-center gap-1.5 min-w-0">
						<span
							className="shrink-0 size-1.5 rounded-full"
							style={{
								backgroundColor: ipInfo.connectedToNetwork
									? "var(--ur-color-green, #22c55e)"
									: "var(--ur-color-gray)",
							}}
						/>
						<span className="text-(--ur-color-gray) font-mono truncate">
							{ipInfo.ip}
						</span>
						{locationParts && (
							<>
								<span className="text-(--ur-color-gray)/50 shrink-0">·</span>
								<span className="text-(--ur-color-gray) truncate">
									{locationParts}
								</span>
							</>
						)}
					</div>
					<a
						href="https://ur.io/ip"
						target="_blank"
						rel="noopener noreferrer"
						className="shrink-0 ml-2 text-(--ur-color-blue-electric) no-underline hover:underline"
					>
						check ↗
					</a>
				</>
			) : null}
		</div>
	);
};
