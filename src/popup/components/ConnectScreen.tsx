import React, { useCallback, useEffect, useRef, useState } from "react";
import { Screen } from "./Screen";
import { IpInfoBanner } from "./IpInfoBanner";
import {
	MenuItem,
	UrButton,
	UrIconHamburger,
	UrIconNetworkInstability,
	UrIconSpinner,
	UrInput,
	UrLocationListItem,
	UrMenu,
	UrMenuButton,
	UrSelectedLocation,
	UrText,
} from "@urnetwork/elements/react";
import { useAuth, useProviderList } from "@urnetwork/sdk-js/react";
import { getMessage } from "@/utils/i18n";
import type { ConnectLocation } from "node_modules/@urnetwork/sdk-js/dist/generated";
import { chromeStorageAdapter } from "@/utils/storage-adapter";
import { fetchIpInfo, type IpInfo } from "@/utils/ip-info";
import { useConnectionManager } from "@/utils/use-connection-manager";
import { useConnectionMode } from "@/utils/use-connection-mode";
import type { ProxyConfig } from "@/utils/proxy-manager";

const STORAGE_KEY_LOCATION = "selected_connect_location";

// ── helpers ──────────────────────────────────────────────────────────────────

function locationKey(location?: ConnectLocation): string {
	if (!location) return "best-available-provider";
	if (location.country_code) return location.country_code;
	if (location.connect_location_id?.location_id)
		return location.connect_location_id.location_id;
	return location.name ?? "";
}

// ── component ─────────────────────────────────────────────────────────────────

export const ConnectScreen: React.FC = () => {
	const { clearAuth } = useAuth();
	const { status, error: connectionError, connect, disconnect, reattach, onProxyChange } =
		useConnectionManager();
	const { mode, setMode } = useConnectionMode();

	const {
		query,
		setQuery,
		filteredLocations,
		error: loadingLocationsError,
		loading: locationsLoading,
		retry,
	} = useProviderList();

	const [proxyConfig, setProxyConfig] = useState<ProxyConfig | null>(null);
	const [selectedLocation, setSelectedLocation] =
		useState<ConnectLocation | null>(null);
	const [isLoggingOut, setIsLoggingOut] = useState(false);
	const ipFailCountRef = useRef(0);
	const [proxyActiveButUnreachable, setProxyActiveButUnreachable] = useState(false);
	const [killSwitch, setKillSwitchLocal] = useState(true);

	useEffect(() => {
		chrome.runtime.sendMessage({ type: "GET_KILL_SWITCH" }).then((res) => {
			if (res?.success) setKillSwitchLocal(res.enabled);
		});
	}, []);

	const handleKillSwitchToggle = useCallback(() => {
		const next = !killSwitch;
		setKillSwitchLocal(next);
		chrome.runtime.sendMessage({ type: "SET_KILL_SWITCH", enabled: next });
	}, [killSwitch]);

	// Register proxy change callback once
	useEffect(() => {
		onProxyChange((config) => setProxyConfig(config));
	}, [onProxyChange]);

	// ── IP info banner ────────────────────────────────────────────────────────

	const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
	const [ipInfoLoading, setIpInfoLoading] = useState(true);
	const [ipInfoError, setIpInfoError] = useState(false);
	const ipPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const statusRef = useRef(status);
	const proxyConfigRef = useRef(proxyConfig);
	useEffect(() => { statusRef.current = status; }, [status]);
	useEffect(() => { proxyConfigRef.current = proxyConfig; }, [proxyConfig]);

	const refreshIpInfo = useCallback(async () => {
		try {
			const info = await fetchIpInfo();
			setIpInfo(info);
			setIpInfoError(false);

			const currentProxy = proxyConfigRef.current;

			if (currentProxy !== null && info.connectedToNetwork) {
				ipFailCountRef.current = 0;
				setProxyActiveButUnreachable(false);
			} else if (currentProxy !== null && !info.connectedToNetwork) {
				ipFailCountRef.current++;
				if (ipFailCountRef.current >= 3) {
					setProxyActiveButUnreachable(true);
				}
			} else {
				ipFailCountRef.current = 0;
				setProxyActiveButUnreachable(false);
			}
		} catch {
			setIpInfoError(true);
		} finally {
			setIpInfoLoading(false);
		}
	}, []);

	useEffect(() => {
		refreshIpInfo();
		ipPollRef.current = setInterval(refreshIpInfo, 15_000);
		return () => {
			if (ipPollRef.current !== null) clearInterval(ipPollRef.current);
		};
	}, [refreshIpInfo]);

	useEffect(() => {
		if (status === "connected" || status === "idle") {
			refreshIpInfo();
		}
	}, [status, refreshIpInfo]);

	// Auto-retry provider list when it errored and connection reaches a stable state
	useEffect(() => {
		if (loadingLocationsError && (status === "connected" || status === "idle")) {
			retry();
		}
	}, [status, loadingLocationsError, retry]);

	// Reset unreachable warning when in multi-ip mode (no single proxyConfig but still connected)
	useEffect(() => {
		if (status === "connected" && proxyConfig === null) {
			ipFailCountRef.current = 0;
			setProxyActiveButUnreachable(false);
		}
	}, [status, proxyConfig]);

	// ── load persisted state on mount ────────────────────────────────────────

	useEffect(() => {
		let cancelled = false;

		async function init() {
			try {
				const [vpnResponse, storedLocation] = await Promise.all([
					chrome.runtime.sendMessage({ type: "GET_VPN_STATE" }),
					chromeStorageAdapter.getItem(STORAGE_KEY_LOCATION),
				]);

				if (cancelled) return;

				let restoredLocation: ConnectLocation | null = null;

				if (storedLocation) {
					try {
						restoredLocation = JSON.parse(storedLocation);
						setSelectedLocation(restoredLocation);
					} catch {
						await chromeStorageAdapter.removeItem(STORAGE_KEY_LOCATION);
					}
				}

				if (vpnResponse?.success && vpnResponse.state?.enabled) {
					const proxyMode = vpnResponse.state.mode ?? "fixed";

					if (proxyMode === "pac") {
						reattach(restoredLocation ?? undefined, "multi-ip");
					} else {
						const config = vpnResponse.state.config ?? null;
						setProxyConfig(config);
						reattach(restoredLocation ?? undefined, "standard");
					}
				}
			} catch (err) {
				if (!cancelled) console.error("Failed to load initial state:", err);
			}
		}

		init();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── refresh selected location's provider count when list updates ─────────

	useEffect(() => {
		if (!selectedLocation) return;

		const all: ConnectLocation[] = [
			...(filteredLocations.best_matches ?? []),
			...(filteredLocations.countries ?? []),
			...(filteredLocations.cities ?? []),
			...(filteredLocations.devices ?? []),
			...(filteredLocations.promoted ?? []),
			...(filteredLocations.regions ?? []),
		];

		const refreshed = all.find(
			(loc) =>
				loc.connect_location_id?.location_id ===
				selectedLocation.connect_location_id?.location_id,
		);

		if (
			refreshed &&
			refreshed.provider_count !== selectedLocation.provider_count
		) {
			setSelectedLocation(refreshed);
		}
	}, [filteredLocations]); // intentionally omit selectedLocation to avoid loops

	// ── connect / disconnect ──────────────────────────────────────────────────

	const handleConnect = useCallback(
		async (location?: ConnectLocation) => {
			await connect(location, mode);
		},
		[connect, mode],
	);

	const handleDisconnect = useCallback(async () => {
		await disconnect();
		setProxyConfig(null);
	}, [disconnect]);

	// Toggle mode: if currently connected, reconnect in new mode immediately
	const handleModeToggle = useCallback(async () => {
		const next = mode === "standard" ? "multi-ip" : "standard";
		setMode(next);

		const isConnected =
			status === "connected" ||
			status === "reconnecting" ||
			status === "degraded" ||
			(proxyConfig !== null && status === "idle");

		if (isConnected) {
			await disconnect();
			setProxyConfig(null);
			await connect(selectedLocation ?? undefined, next);
		}
	}, [mode, setMode, status, proxyConfig, disconnect, connect, selectedLocation]);

	// ── location selection ────────────────────────────────────────────────────

	const selectLocation = useCallback(
		async (location: ConnectLocation) => {
			setSelectedLocation(location);
			await chromeStorageAdapter.setItem(
				STORAGE_KEY_LOCATION,
				JSON.stringify(location),
			);
			handleConnect(location);
		},
		[handleConnect],
	);

	const selectBestAvailable = useCallback(async () => {
		setSelectedLocation(null);
		await chromeStorageAdapter.removeItem(STORAGE_KEY_LOCATION);
		handleConnect();
	}, [handleConnect]);

	// ── logout ────────────────────────────────────────────────────────────────

	const handleLogout = useCallback(async () => {
		setIsLoggingOut(true);
		const hasActiveProxy = proxyConfig !== null || status === "connected" || status === "reconnecting" || status === "degraded";
		if (hasActiveProxy) {
			await handleDisconnect();
		}
		await chromeStorageAdapter.removeItem(STORAGE_KEY_LOCATION);
		clearAuth();
		setIsLoggingOut(false);
	}, [proxyConfig, status, handleDisconnect, clearAuth]);

	// ── render ────────────────────────────────────────────────────────────────

	if (isLoggingOut) {
		return (
			<Screen>
				<div className="flex w-full justify-center py-ur-2xl">
					<UrIconSpinner />
				</div>
			</Screen>
		);
	}

	const isActive =
		status === "connected" ||
		(proxyConfig !== null && status === "idle");
	const isConnecting = status === "connecting";
	const isReconnecting = status === "reconnecting" || status === "degraded";
	const isMultiIp = mode === "multi-ip";

	return (
		<Screen>
			{/* ── sticky header ── */}
			<div className="p-ur-md shrink-0 bg-(--ur-color-black) border-b border-(--ur-color-border) relative z-10">
				<IpInfoBanner ipInfo={ipInfo} loading={ipInfoLoading} error={ipInfoError} />

				<div className="mb-ur-lg">
					{/* top bar */}
					<div className="flex w-full justify-end mb-ur-sm">
						<UrMenu>
							<UrMenuButton>
								<UrIconHamburger className="size-6" />
							</UrMenuButton>
							<MenuItem
								className="text-left"
								onMenuItemClick={handleLogout}
							>
								<UrText>Logout</UrText>
							</MenuItem>
						</UrMenu>
					</div>

					{/* selected location indicator */}
					<div className="mb-ur-sm">
						{selectedLocation ? (
							<UrSelectedLocation
								key={locationKey(selectedLocation)}
								locationKey={locationKey(selectedLocation)}
								name={selectedLocation.name}
								providerCount={selectedLocation.provider_count}
								strongPrivacy={selectedLocation.strong_privacy}
								unstable={!selectedLocation.stable}
							/>
						) : (
							<UrSelectedLocation locationKey="best-available-provider" />
						)}
					</div>

					{/* reconnecting notice */}
					{isReconnecting && (
						<div className="flex items-center gap-ur-sm mb-ur-sm">
							<UrIconSpinner size={0.75} />
							<UrText variant="small" className="text-(--ur-color-yellow-light)">
								Reconnecting...
							</UrText>
						</div>
					)}

					{/* connect / disconnect */}
					{isActive || isReconnecting || isConnecting ? (
						<UrButton
							onClick={handleDisconnect}
							loading={false}
							disabled={false}
							variant="secondary"
							fullWidth
						>
							<UrText>{getMessage("disconnect")}</UrText>
						</UrButton>
					) : (
						<UrButton
							onClick={() => handleConnect()}
							loading={isConnecting}
							disabled={isConnecting}
							fullWidth
						>
							<UrText>{getMessage("connect")}</UrText>
						</UrButton>
					)}

					{/* proxy active but IP check says not on network */}
					{proxyActiveButUnreachable && !isReconnecting && (
						<div className="mt-ur-sm">
							<UrText variant="small" className="text-(--ur-color-yellow-light)">
								Proxy active but network unreachable. Reconnecting...
							</UrText>
						</div>
					)}

					{/* multi-IP mode toggle — always visible */}
					<div className="mt-ur-sm flex items-center justify-between gap-ur-sm py-ur-sm border-t border-(--ur-color-border)">
						<div className="flex flex-col gap-0.5 flex-1 min-w-0">
							<UrText variant="small">Multi-IP Mode</UrText>
							<UrText variant="small" className="text-(--ur-color-text-secondary) text-xs leading-tight">
								{isConnecting && isMultiIp
									? "Provisioning connections..."
									: isMultiIp
										? "Each tab uses a separate IP address"
										: "All tabs share a single IP address"}
							</UrText>
						</div>
						{isConnecting && isMultiIp ? (
							<div className="shrink-0 flex items-center justify-center w-11 h-6">
								<UrIconSpinner size={0.65} />
							</div>
						) : (
							<button
								type="button"
								onClick={handleModeToggle}
								disabled={isConnecting}
								aria-label="Toggle multi-IP mode"
								style={{
									backgroundColor: isMultiIp
										? "var(--ur-color-primary, #22c55e)"
										: "var(--ur-color-border, #3f3f46)",
								}}
								className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
							>
								<span
									className={[
										"pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow",
										"transform transition duration-200 ease-in-out",
										isMultiIp ? "translate-x-5" : "translate-x-0",
									].join(" ")}
								/>
							</button>
						)}
					</div>

					{/* kill switch toggle */}
					<div className="mt-ur-sm flex items-center justify-between gap-ur-sm py-ur-sm border-t border-(--ur-color-border)">
						<div className="flex flex-col gap-0.5 flex-1 min-w-0">
							<UrText variant="small">Kill Switch</UrText>
							<UrText variant="small" className="text-(--ur-color-text-secondary) text-xs leading-tight">
								{killSwitch
									? "Traffic blocked if all nodes fail"
									: "Traffic may leak if all nodes fail"}
							</UrText>
						</div>
						<button
							type="button"
							onClick={handleKillSwitchToggle}
							aria-label="Toggle kill switch"
							style={{
								backgroundColor: killSwitch
									? "var(--ur-color-primary, #22c55e)"
									: "var(--ur-color-border, #3f3f46)",
							}}
							className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none"
						>
							<span
								className={[
									"pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow",
									"transform transition duration-200 ease-in-out",
									killSwitch ? "translate-x-5" : "translate-x-0",
								].join(" ")}
							/>
						</button>
					</div>

					{/* error feedback */}
					{status === "error" && connectionError && (
						<div className="mt-ur-sm flex items-center gap-ur-sm">
							<UrText variant="small" className="text-ur-coral flex-1">
								{connectionError}
							</UrText>
							<UrButton variant="secondary" onClick={() => handleConnect(selectedLocation ?? undefined)}>
								<UrText variant="small">{getMessage("retry")}</UrText>
							</UrButton>
						</div>
					)}
				</div>

				<UrInput
					label={getMessage("search_providers_input_label")}
					placeholder={getMessage("search_providers_input_placeholder")}
					value={query}
					onInput={(e) => setQuery(e.detail.value)}
				/>
			</div>

			{/* ── location list ── */}
			{locationsLoading ? (
				<div className="flex py-ur-lg justify-center">
					<UrIconSpinner size={1.2} />
				</div>
			) : loadingLocationsError ? (
				<div className="flex flex-col items-center justify-center py-ur-lg gap-ur-md">
					<UrIconNetworkInstability className="text-ur-yellow-light size-ur-lg" />
					<UrText variant="small" className="text-ur-gray">
						{getMessage("something_went_wrong")}
					</UrText>
					<UrButton variant="secondary" onClick={retry}>
						<UrText>{getMessage("retry")}</UrText>
					</UrButton>
				</div>
			) : (
				<div id="locations-list" className="flex-1 overflow-y-auto pb-ur-md">
					{/* Best available — only shown when search is empty */}
					{query.length === 0 && (
						<>
							<LocationsGroupLabel groupLabel={getMessage("promoted")} />
							<ul>
								<UrLocationListItem
									locationKey="best-available-provider"
									name={getMessage("best_available_provider")}
									onClick={selectBestAvailable}
									strongPrivacy={false}
									unstable={false}
								/>
							</ul>
						</>
					)}

					{filteredLocations.best_matches &&
						filteredLocations.best_matches.length > 0 && (
							<LocationsGroup
								groupLabel={getMessage("best_matches")}
								locations={filteredLocations.best_matches}
								onSelect={selectLocation}
							/>
						)}

					{filteredLocations.countries &&
						filteredLocations.countries.length > 0 && (
							<LocationsGroup
								groupLabel={getMessage("countries")}
								locations={filteredLocations.countries}
								onSelect={selectLocation}
							/>
						)}

					{filteredLocations.cities &&
						filteredLocations.cities.length > 0 && (
							<LocationsGroup
								groupLabel={getMessage("cities")}
								locations={filteredLocations.cities}
								onSelect={selectLocation}
							/>
						)}

					{filteredLocations.devices &&
						filteredLocations.devices.length > 0 && (
							<LocationsGroup
								groupLabel={getMessage("devices")}
								locations={filteredLocations.devices}
								onSelect={selectLocation}
							/>
						)}

					{filteredLocations.regions &&
						filteredLocations.regions.length > 0 && (
							<LocationsGroup
								groupLabel={getMessage("regions")}
								locations={filteredLocations.regions}
								onSelect={selectLocation}
							/>
						)}
				</div>
			)}
		</Screen>
	);
};

// ── sub-components ─────────────────────────────────────────────────────────────

interface LocationsGroupProps {
	groupLabel: string;
	locations: ConnectLocation[];
	onSelect: (location: ConnectLocation) => void;
}

export const LocationsGroup: React.FC<LocationsGroupProps> = ({
	groupLabel,
	locations,
	onSelect,
}) => (
	<>
		<LocationsGroupLabel groupLabel={groupLabel} />
		<ul>
			{locations.map((location) => (
				<UrLocationListItem
					key={locationKey(location)}
					locationKey={locationKey(location)}
					name={location.name}
					providerCount={location.provider_count}
					onClick={() => onSelect(location)}
					strongPrivacy={location.strong_privacy}
					unstable={!location.stable}
				/>
			))}
		</ul>
	</>
);

interface LocationsGroupLabelProps {
	groupLabel: string;
}

export const LocationsGroupLabel: React.FC<LocationsGroupLabelProps> = ({
	groupLabel,
}) => (
	<div className="sticky top-0 bg-ur-black z-10 px-ur-md py-ur-sm text-left border-b border-t border-(--ur-color-border) shadow-md">
		<UrText variant="body">{groupLabel}</UrText>
	</div>
);

export default ConnectScreen;
