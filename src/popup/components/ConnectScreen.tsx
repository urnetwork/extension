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
import { useAuth } from "@urnetwork/sdk-js/react";
import { getMessage } from "@/utils/i18n";
import type { ConnectLocation } from "node_modules/@urnetwork/sdk-js/dist/generated";
import { chromeStorageAdapter } from "@/utils/storage-adapter";
import { fetchIpInfo, type IpInfo } from "@/utils/ip-info";
import { useConnectionManager } from "@/utils/use-connection-manager";
import { useProviderListEnhanced, type RegionGroup } from "@/utils/use-provider-list-enhanced";
import {
	getGeoSyncEnabled,
	getGeoSyncPosition,
	setGeoSyncEnabled as persistGeoSyncEnabled,
} from "@/utils/geo-sync";
import {
	STORAGE_KEY_GEO_ENABLED,
	STORAGE_KEY_GEO_POSITION,
	type GeoSyncPosition,
} from "@/content/geo-protocol";

const STORAGE_KEY_LOCATION = "selected_connect_location";

function locationKey(location?: ConnectLocation): string {
	if (!location) return "best-available-provider";
	if (location.country_code) return location.country_code;
	if (location.connect_location_id?.location_id)
		return location.connect_location_id.location_id;
	return location.name ?? "";
}

export const ConnectScreen: React.FC = () => {
	const { clearAuth } = useAuth();
	const { status, error: connectionError, connect, disconnect, reattach, onProxyChange } =
		useConnectionManager();

	const {
		query,
		setQuery,
		filteredLocations,
		error: loadingLocationsError,
		loading: locationsLoading,
		retry,
	} = useProviderListEnhanced();

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

	// ── location sync (geolocation override) ─────────────────────────────────
	// Opt-in, off by default. Both pieces of state live in chrome.storage.local
	// so the content scripts read them directly (see content/geo-config.ts) —
	// this screen only mirrors them.
	const [geoSync, setGeoSync] = useState(false);
	const [geoPosition, setGeoPosition] = useState<GeoSyncPosition | null>(null);

	useEffect(() => {
		let cancelled = false;
		Promise.all([getGeoSyncEnabled(), getGeoSyncPosition()]).then(([enabled, position]) => {
			if (cancelled) return;
			setGeoSync(enabled);
			setGeoPosition(position);
		});
		const onStorageChanged = (
			changes: Record<string, chrome.storage.StorageChange>,
			area: string,
		) => {
			if (area !== "local") return;
			if (changes[STORAGE_KEY_GEO_ENABLED]) {
				setGeoSync(changes[STORAGE_KEY_GEO_ENABLED].newValue === true);
			}
			if (changes[STORAGE_KEY_GEO_POSITION]) {
				const next = changes[STORAGE_KEY_GEO_POSITION].newValue;
				setGeoPosition(next && typeof next === "object" ? (next as GeoSyncPosition) : null);
			}
		};
		chrome.storage.onChanged.addListener(onStorageChanged);
		return () => {
			cancelled = true;
			chrome.storage.onChanged.removeListener(onStorageChanged);
		};
	}, []);

	const handleGeoSyncToggle = useCallback(() => {
		const next = !geoSync;
		setGeoSync(next);
		if (!next) setGeoPosition(null);
		persistGeoSyncEnabled(next).catch(() => {});
	}, [geoSync]);

	useEffect(() => {
		onProxyChange(() => {});
	}, [onProxyChange]);

	// ── IP info ──────────────────────────────────────────────────────────────
	const [ipInfo, setIpInfo] = useState<IpInfo | null>(null);
	const [ipInfoLoading, setIpInfoLoading] = useState(true);
	const [ipInfoError, setIpInfoError] = useState(false);
	const ipPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const statusRef = useRef(status);
	useEffect(() => { statusRef.current = status; }, [status]);

	const refreshIpInfo = useCallback(async () => {
		try {
			const info = await fetchIpInfo();
			setIpInfo(info);
			setIpInfoError(false);
			const currentlyActive = statusRef.current === "connected" || statusRef.current === "reconnecting" || statusRef.current === "degraded";
			if (currentlyActive && info.connectedToNetwork) {
				ipFailCountRef.current = 0;
				setProxyActiveButUnreachable(false);
			} else if (currentlyActive && !info.connectedToNetwork) {
				ipFailCountRef.current++;
				if (ipFailCountRef.current >= 3) setProxyActiveButUnreachable(true);
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
		return () => { if (ipPollRef.current !== null) clearInterval(ipPollRef.current); };
	}, [refreshIpInfo]);

	useEffect(() => {
		if (status === "connected" || status === "idle") refreshIpInfo();
	}, [status, refreshIpInfo]);

	useEffect(() => {
		if (loadingLocationsError && (status === "connected" || status === "idle")) retry();
	}, [status, loadingLocationsError, retry]);

	useEffect(() => {
		if (status === "idle") {
			ipFailCountRef.current = 0;
			setProxyActiveButUnreachable(false);
		}
	}, [status]);

	// ── load persisted state on mount ────────────────────────────────────────
	useEffect(() => {
		let cancelled = false;
		async function init() {
			try {
				// Clear stale connection_mode key from older versions
				chrome.storage.local.remove("connection_mode");

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
					reattach(restoredLocation ?? undefined);
				}
			} catch (err) {
				if (!cancelled) console.error("Failed to load initial state:", err);
			}
		}
		init();
		return () => { cancelled = true; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── refresh selected location provider count ─────────────────────────────
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
			(loc) => loc.connect_location_id?.location_id === selectedLocation.connect_location_id?.location_id,
		);
		if (refreshed && refreshed.provider_count !== selectedLocation.provider_count) {
			setSelectedLocation(refreshed);
		}
	}, [filteredLocations]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── connect / disconnect ─────────────────────────────────────────────────
	const handleConnect = useCallback(
		async (location?: ConnectLocation) => { await connect(location); },
		[connect],
	);

	const handleDisconnect = useCallback(async () => {
		await disconnect();
	}, [disconnect]);

	// ── location selection ────────────────────────────────────────────────────

	// Apply a location change. When already connected, try to delegate the change
	// to an attached ur.io app's DeviceRemote (device-rpc → the hosted device
	// re-routes with NO proxy reconnect, and every attached surface gets
	// connectLocationChange). If no app is attached (or delegation fails), fall
	// back to the normal connect/swap. When idle, just connect here.
	const applyLocationChange = useCallback(
		async (location: ConnectLocation | null) => {
			setSelectedLocation(location);
			if (location) {
				await chromeStorageAdapter.setItem(STORAGE_KEY_LOCATION, JSON.stringify(location));
			} else {
				await chromeStorageAdapter.removeItem(STORAGE_KEY_LOCATION);
			}

			const isConnected =
				status === "connected" ||
				status === "reconnecting" ||
				status === "degraded";

			if (isConnected) {
				try {
					const res = await chrome.runtime.sendMessage({
						type: "CHANGE_LOCATION",
						locationId: location?.connect_location_id?.location_id ?? null,
						name: location?.name,
					});
					if (res?.success && res.delegated) {
						return; // an app applied it over the device-rpc — no reconnect
					}
				} catch {
					// no receiver / delegation failed — fall through to reconnect
				}
			}
			await handleConnect(location ?? undefined);
		},
		[status, handleConnect],
	);

	const selectLocation = useCallback(
		(location: ConnectLocation) => applyLocationChange(location),
		[applyLocationChange],
	);

	const selectBestAvailable = useCallback(
		() => applyLocationChange(null),
		[applyLocationChange],
	);

	// Reflect an app-initiated location change (scenario 2) while the popup is
	// open: the background broadcasts LOCATION_UPDATED after the app re-routed
	// the hosted device. Just update the displayed location — no reconnect.
	useEffect(() => {
		const onMessage = (msg: { type?: string; locationId?: string | null; name?: string }) => {
			if (msg?.type !== "LOCATION_UPDATED") return;
			setSelectedLocation(
				msg.locationId
					? ({
							connect_location_id: { location_id: msg.locationId },
							...(msg.name ? { name: msg.name } : {}),
						} as ConnectLocation)
					: null,
			);
		};
		chrome.runtime.onMessage.addListener(onMessage);
		return () => chrome.runtime.onMessage.removeListener(onMessage);
	}, []);

	// ── logout ───────────────────────────────────────────────────────────────
	const handleLogout = useCallback(async () => {
		setIsLoggingOut(true);
		const hasActiveProxy = status === "connected" || status === "reconnecting" || status === "degraded";
		if (hasActiveProxy) await handleDisconnect();
		await chromeStorageAdapter.removeItem(STORAGE_KEY_LOCATION);
		clearAuth();
		setIsLoggingOut(false);
	}, [status, handleDisconnect, clearAuth]);

	// ── render ───────────────────────────────────────────────────────────────
	if (isLoggingOut) {
		return (
			<Screen>
				<div className="flex w-full h-full items-center justify-center">
					<UrIconSpinner />
				</div>
			</Screen>
		);
	}

	const isActive = status === "connected";
	const isConnecting = status === "connecting";
	const isReconnecting = status === "reconnecting" || status === "degraded";

	// The note under the location sync toggle: the resting line describes the
	// rule (oldest connected provider = the most stable one), and the two live
	// states replace it once the toggle is on.
	const geoSyncNote = (() => {
		if (!geoSync) return getMessage("use_most_stable_provider");
		if (!geoPosition) return getMessage("mock_location_waiting_for_provider");
		const place =
			geoPosition.label || `${geoPosition.lat.toFixed(3)}, ${geoPosition.lon.toFixed(3)}`;
		const template = getMessage("mock_location_active");
		return template ? template.replace("{location}", place) : place;
	})();

	return (
		<Screen>
			{/* ── Left Panel: Connection Controls ── */}
			<div className="w-[280px] shrink-0 h-full flex flex-col" style={{ background: "var(--color-surface-1)" }}>
				{/* Header with menu */}
				<div className="flex items-center justify-between px-5 pt-4 pb-2">
					<span className="text-sm font-semibold tracking-wide opacity-60 uppercase">URnetwork</span>
					<UrMenu>
						<UrMenuButton>
							<UrIconHamburger className="size-5 opacity-60 hover:opacity-100 transition-opacity" />
						</UrMenuButton>
						<MenuItem className="text-left" onMenuItemClick={handleLogout}>
							<UrText>Logout</UrText>
						</MenuItem>
					</UrMenu>
				</div>

				{/* IP Info */}
				<div className="px-4 mb-3">
					<IpInfoBanner ipInfo={ipInfo} loading={ipInfoLoading} error={ipInfoError} />
				</div>

				{/* Selected location card */}
				<div className="px-4 mb-3">
					<div className="rounded-xl p-3" style={{ background: "var(--color-surface-2)" }}>
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
				</div>

				{/* Reconnecting notice */}
				{isReconnecting && (
					<div className="flex items-center gap-2 px-4 mb-2">
						<UrIconSpinner size={0.65} />
						<span className="text-xs" style={{ color: "var(--ur-color-yellow-light)" }}>
							Reconnecting...
						</span>
					</div>
				)}

				{/* Connect / Disconnect button */}
				<div className="px-4 mb-4">
					{isActive || isReconnecting || isConnecting ? (
						<UrButton onClick={handleDisconnect} loading={false} disabled={false} variant="secondary" fullWidth>
							<UrText>{getMessage("disconnect")}</UrText>
						</UrButton>
					) : (
						<UrButton onClick={() => handleConnect()} loading={isConnecting} disabled={isConnecting} fullWidth>
							<UrText>{getMessage("connect")}</UrText>
						</UrButton>
					)}

					{proxyActiveButUnreachable && !isReconnecting && (
						<p className="mt-2 text-xs" style={{ color: "var(--ur-color-yellow-light)" }}>
							Proxy active but network unreachable.
						</p>
					)}

					{status === "error" && connectionError && (
						<div className="mt-2 flex items-center gap-2">
							<span className="text-xs flex-1" style={{ color: "var(--ur-color-coral)" }}>
								{connectionError}
							</span>
							<UrButton variant="secondary" onClick={() => handleConnect(selectedLocation ?? undefined)}>
								<UrText variant="small">{getMessage("retry")}</UrText>
							</UrButton>
						</div>
					)}
				</div>

				{/* Settings toggles */}
				<div className="px-4 flex-1 flex flex-col gap-2">
					<div className="rounded-xl p-3 flex flex-col gap-3" style={{ background: "var(--color-surface-2)" }}>
						{/* Kill switch toggle */}
						<div className="flex items-center justify-between gap-2">
							<div className="flex flex-col gap-0.5 flex-1 min-w-0">
								<span className="text-xs font-medium">Kill Switch</span>
								<span className="text-[10px] opacity-50 leading-tight">
									{killSwitch ? "Blocks traffic on failure" : "Traffic may leak on failure"}
								</span>
							</div>
							<ToggleSwitch enabled={killSwitch} onToggle={handleKillSwitchToggle} label="Toggle kill switch" />
						</div>

						{/* Location sync (geolocation override) */}
						<div className="flex flex-col gap-1">
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs font-medium flex-1 min-w-0">
									{getMessage("sync_device_location_with_provider")}
								</span>
								<ToggleSwitch
									enabled={geoSync}
									onToggle={handleGeoSyncToggle}
									label={getMessage("sync_device_location_with_provider")}
								/>
							</div>
							<span className="text-[10px] opacity-60 leading-tight">{geoSyncNote}</span>
							{/* honest scope: a page-level shim, not a device or browser guarantee */}
							<span className="text-[10px] opacity-50 leading-tight">
								{getMessage("mock_location_disclosure_browser_only")}
							</span>
							{geoSync && (
								<span className="text-[10px] opacity-50 leading-tight">
									{getMessage("mock_location_disclosure_sites_can_detect")}
								</span>
							)}
						</div>
					</div>
				</div>

				{/* Connection status indicator at bottom */}
				<div className="px-4 py-3 mt-auto">
					<div className="flex items-center gap-2">
						<span
							className="size-2 rounded-full shrink-0 transition-colors duration-300"
							style={{
								backgroundColor: isActive
									? "var(--ur-color-green, #22c55e)"
									: isConnecting || isReconnecting
										? "var(--ur-color-yellow-light, #fbbf24)"
										: "var(--ur-color-gray, #6b7280)",
							}}
						/>
						<span className="text-[11px] opacity-60">
							{isActive ? "Connected" : isConnecting ? "Connecting..." : isReconnecting ? "Reconnecting..." : "Disconnected"}
						</span>
					</div>
				</div>
			</div>

			{/* ── Right Panel: Location List ── */}
			<div className="flex-1 h-full flex flex-col" style={{ background: "var(--color-surface-0)" }}>
				{/* Search header */}
				<div className="px-4 pt-4 pb-3">
					<p className="text-center text-xs font-medium opacity-50 mb-2">{getMessage("search_providers_input_label")}</p>
					<div className="rounded-xl overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
						<UrInput
							placeholder="Search countries, cities, regions..."
							value={query}
							onInput={(e) => setQuery(e.detail.value)}
						/>
					</div>
				</div>

				{/* Location list */}
				{locationsLoading ? (
					<div className="flex py-8 justify-center">
						<UrIconSpinner size={1.2} />
					</div>
				) : loadingLocationsError ? (
					<div className="flex flex-col items-center justify-center py-8 gap-3">
						<UrIconNetworkInstability className="size-8 opacity-60" />
						<UrText variant="small" className="opacity-60">
							{getMessage("something_went_wrong")}
						</UrText>
						<UrButton variant="secondary" onClick={retry}>
							<UrText>{getMessage("retry")}</UrText>
						</UrButton>
					</div>
				) : (
					<div className="flex-1 overflow-y-auto px-4 pb-4">
						{query.length === 0 && (
							<LocationsSection label={getMessage("promoted")}>
								<UrLocationListItem
									locationKey="best-available-provider"
									name={getMessage("best_available_provider")}
									onClick={selectBestAvailable}
									strongPrivacy={false}
									unstable={false}
								/>
							</LocationsSection>
						)}

						{filteredLocations.best_matches && filteredLocations.best_matches.length > 0 && (
							<LocationsSection label={getMessage("best_matches")}>
								{filteredLocations.best_matches.map((location) => (
									<UrLocationListItem
										key={locationKey(location)}
										locationKey={locationKey(location)}
										name={location.name}
										providerCount={location.provider_count}
										onClick={() => selectLocation(location)}
										strongPrivacy={location.strong_privacy}
										unstable={!location.stable}
									/>
								))}
							</LocationsSection>
						)}

						{filteredLocations.countries && filteredLocations.countries.length > 0 && (
							<LocationsSection label={getMessage("countries")}>
								{filteredLocations.countries.map((location) => (
									<UrLocationListItem
										key={locationKey(location)}
										locationKey={locationKey(location)}
										name={location.name}
										providerCount={location.provider_count}
										onClick={() => selectLocation(location)}
										strongPrivacy={location.strong_privacy}
										unstable={!location.stable}
									/>
								))}
							</LocationsSection>
						)}

						{/* Search mode: regions as headers with cities nested */}
						{filteredLocations.region_groups && filteredLocations.region_groups.length > 0 && (
							<RegionGroupedList
								groups={filteredLocations.region_groups}
								onSelectLocation={selectLocation}
							/>
						)}

						{/* Non-search mode: standalone cities and regions */}
						{!filteredLocations.region_groups && filteredLocations.cities && filteredLocations.cities.length > 0 && (
							<LocationsSection label={getMessage("cities")}>
								{filteredLocations.cities.map((location) => (
									<UrLocationListItem
										key={locationKey(location)}
										locationKey={locationKey(location)}
										name={location.name}
										providerCount={location.provider_count}
										onClick={() => selectLocation(location)}
										strongPrivacy={location.strong_privacy}
										unstable={!location.stable}
									/>
								))}
							</LocationsSection>
						)}

						{!filteredLocations.region_groups && filteredLocations.regions && filteredLocations.regions.length > 0 && (
							<LocationsSection label={getMessage("regions")}>
								{filteredLocations.regions.map((location) => (
									<UrLocationListItem
										key={locationKey(location)}
										locationKey={locationKey(location)}
										name={location.name}
										providerCount={location.provider_count}
										onClick={() => selectLocation(location)}
										strongPrivacy={location.strong_privacy}
										unstable={!location.stable}
									/>
								))}
							</LocationsSection>
						)}

						{filteredLocations.devices && filteredLocations.devices.length > 0 && (
							<LocationsSection label={getMessage("devices")}>
								{filteredLocations.devices.map((location) => (
									<UrLocationListItem
										key={locationKey(location)}
										locationKey={locationKey(location)}
										name={location.name}
										providerCount={location.provider_count}
										onClick={() => selectLocation(location)}
										strongPrivacy={location.strong_privacy}
										unstable={!location.stable}
									/>
								))}
							</LocationsSection>
						)}
					</div>
				)}
			</div>
		</Screen>
	);
};

// ── Sub-components ───────────────────────────────────────────────────────────

const LocationsSection: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
	<div className="mb-2">
		<div className="sticky top-0 z-10 py-2 px-1" style={{ background: "var(--color-surface-0)" }}>
			<span className="text-[11px] font-semibold uppercase tracking-wider opacity-40">{label}</span>
		</div>
		<div className="rounded-xl overflow-hidden" style={{ background: "var(--color-surface-1)" }}>
			{children}
		</div>
	</div>
);

const RegionGroupedList: React.FC<{
	groups: RegionGroup[];
	onSelectLocation: (location: ConnectLocation) => void;
}> = ({ groups, onSelectLocation }) => (
	<div className="mb-2">
		<div className="sticky top-0 z-10 py-2 px-1" style={{ background: "var(--color-surface-0)" }}>
			<span className="text-[11px] font-semibold uppercase tracking-wider opacity-40">Regions</span>
		</div>
		{groups.map((group) => (
			<div key={locationKey(group.region)} className="mb-2">
				{/* Region header */}
				<div className="rounded-xl overflow-hidden" style={{ background: "var(--color-surface-1)" }}>
					<UrLocationListItem
						locationKey={locationKey(group.region)}
						name={group.region.name}
						providerCount={group.region.provider_count}
						onClick={() => onSelectLocation(group.region)}
						strongPrivacy={group.region.strong_privacy}
						unstable={!group.region.stable}
					/>
				</div>
				{/* Nested cities */}
				{group.cities.length > 0 && (
					<div className="ml-4 mt-1 rounded-xl overflow-hidden" style={{ background: "var(--color-surface-1)" }}>
						{group.cities.map((city) => (
							<UrLocationListItem
								key={locationKey(city)}
								locationKey={locationKey(city)}
								name={city.name}
								providerCount={city.provider_count}
								onClick={() => onSelectLocation(city)}
								strongPrivacy={city.strong_privacy}
								unstable={!city.stable}
							/>
						))}
					</div>
				)}
			</div>
		))}
	</div>
);

const ToggleSwitch: React.FC<{
	enabled: boolean;
	onToggle: () => void;
	disabled?: boolean;
	label: string;
}> = ({ enabled, onToggle, disabled, label }) => (
	<button
		type="button"
		onClick={onToggle}
		disabled={disabled}
		aria-label={label}
		className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
		style={{
			backgroundColor: enabled ? "var(--ur-color-green, #22c55e)" : "var(--color-surface-3, #3f3f46)",
		}}
	>
		<span
			className="pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition duration-200 ease-in-out"
			style={{ transform: enabled ? "translateX(16px)" : "translateX(0)" }}
		/>
	</button>
);

export default ConnectScreen;
