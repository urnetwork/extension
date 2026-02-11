import React, { useEffect, useState } from "react";
import { Screen } from "./Screen";
import {
	MenuItem,
	UrButton,
	UrIconHamburger,
	UrIconNetworkInstability,
	UrInput,
	UrMenu,
	UrMenuButton,
	UrSelectedLocation,
	UrText,
} from "@urnetwork/elements/react";
import {
	parseByJwtClientId,
	useAuth,
	useAuthNetworkClient,
	useProviderList,
	useRemoveNetworkClient,
} from "@urnetwork/sdk-js/react";
import type { ProxyState } from "@/utils/proxy-manager";
import { getMessage } from "@/utils/i18n";
import type {
	AuthNetworkClientArgs,
	ConnectLocation,
} from "node_modules/@urnetwork/sdk-js/dist/generated";
import { UrLocationListItem } from "@urnetwork/elements/react";
import { UrIconSpinner } from "@urnetwork/elements/react";
import { chromeStorageAdapter } from "@/utils/storage-adapter";

export const ConnectScreen: React.FC = () => {
	const { clearAuth } = useAuth();
	const { error: authNetworkClientError, authNetworkClient } =
		useAuthNetworkClient();

	const { removeNetworkClient } = useRemoveNetworkClient();

	const {
		query,
		setQuery,
		filteredLocations,
		error: loadingLocationsError,
		loading: locationsLoading,
		retry,
	} = useProviderList();

	const [vpnState, setVpnState] = useState<ProxyState>({
		enabled: false,
		config: null,
	});
	const [isConnecting, setIsConnecting] = useState(false);
	const [isDisconnecting, setIsDisconnecting] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [selectedLocation, setSelectedLocation] =
		useState<ConnectLocation | null>(null);
	const [isLoggingOut, setIsLoggingOut] = useState(false);

	// Load VPN state on mount
	useEffect(() => {
		const loadVpnState = async () => {
			try {
				const response = await chrome.runtime.sendMessage({
					type: "GET_VPN_STATE",
				});
				if (response.success && response.state) {
					setVpnState(response.state);
				}
			} catch (err) {
				console.error("Failed to load VPN state:", err);
			}
		};

		const loadSelectedLocation = async () => {
			const stored = await chromeStorageAdapter.getItem(
				"selected_connect_location",
			);
			if (stored) {
				const location = JSON.parse(stored);
				setSelectedLocation(location);
			}
		};

		loadVpnState();
		loadSelectedLocation();
	}, []);

	useEffect(() => {
		const refreshSelectedLocation = async () => {
			if (!selectedLocation) {
				return;
			}

			const flattenedLocations: ConnectLocation[] = [
				...(filteredLocations.best_matches || []),
				...(filteredLocations.countries || []),
				...(filteredLocations.cities || []),
				...(filteredLocations.devices || []),
				...(filteredLocations.promoted || []),
				...(filteredLocations.regions || []),
			];

			const targetLocation = flattenedLocations.find((loc) => {
				return (
					selectedLocation.connect_location_id?.location_id ===
					loc.connect_location_id?.location_id
				);
			});

			if (
				targetLocation &&
				targetLocation.provider_count !== selectedLocation.provider_count
			) {
				// only update if provider count is different
				setSelectedLocation(targetLocation);
			}
		};
		refreshSelectedLocation();
	}, [selectedLocation, filteredLocations]);

	const connectLocation = async (location: ConnectLocation) => {
		setSelectedLocation(location);
		await chromeStorageAdapter.setItem(
			"selected_connect_location",
			JSON.stringify(location),
		);

		handleConnect(location);
	};

	const connectBestAvailable = async () => {
		setSelectedLocation(null);
		await chromeStorageAdapter.removeItem("selected_connect_location");
		handleConnect();
	};

	const setProxyClientId = async (clientId: string) => {
		try {
			await chromeStorageAdapter.setItem("proxy_client_id", clientId);
		} catch (error) {
			console.error("Error setting proxy client ID:", error);
		}
	};

	const clearProxyClientId = async () => {
		try {
			await chromeStorageAdapter.removeItem("proxy_client_id");
		} catch (error) {
			console.error("Error removing proxy client ID:", error);
		}
	};

	const getProxyClientId = async (): Promise<string | null> => {
		try {
			const clientId = await chromeStorageAdapter.getItem("proxy_client_id");
			return clientId;
		} catch (error) {
			console.error("Error getting proxy client ID:", error);
			return null;
		}
	};

	const handleConnect = async (connectLocation?: ConnectLocation) => {
		setIsConnecting(true);
		setConnectError(null);

		if (vpnState.enabled) {
			// clean up existing connection first
			// need to delete the previous network client id
			await handleDisconnect();
		}

		const authParams: AuthNetworkClientArgs = {
			description: "",
			device_spec: "",
		};

		if (connectLocation) {
			authParams.proxy_config = {
				lock_caller_ip: false,
				lock_ip_list: [],
				enable_socks: true,
				enable_http: true,
				http_require_auth: false,
				initial_device_state: {
					location: {
						connect_location_id: {
							location_id: connectLocation.connect_location_id?.location_id,
						},
						stable: true, // todo - these should be optional in the SDK
						strong_privacy: true, // todo - these should be optional in the SDK
					},
					performance_profile: null,
				},
			};
		} else {
			/**
			 * connect best available
			 */
			authParams.proxy_config = {
				lock_caller_ip: false,
				lock_ip_list: [],
				enable_socks: true,
				enable_http: true,
				http_require_auth: false,
				initial_device_state: {
					location: {
						connect_location_id: {
							best_available: true,
						},
						stable: true, // todo - these should be optional in the SDK
						strong_privacy: true, // todo - these should be optional in the SDK
					},
					performance_profile: null,
				},
			};
		}

		const result = await authNetworkClient(authParams);

		if (result.error) {
			console.error("Auth network client error:", result.error);
			setConnectError(result.error.message);
			setIsConnecting(false);
			return;
		}

		if (!result.by_client_jwt) {
			console.error("No client JWT returned");
			setConnectError("Authentication failed: No client token received");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result) {
			console.error("No proxy config result returned");
			setConnectError("No proxy configuration available");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result.auth_token) {
			console.error("No auth token in proxy config result");
			setConnectError("No authentication token available for VPN");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result.proxy_host) {
			console.error("No proxy host in proxy config result");
			setConnectError("No proxy host available for VPN");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result.https_proxy_port) {
			console.error("No proxy port in proxy config result");
			setConnectError("No proxy port available for VPN");
			setIsConnecting(false);
			return;
		}

		const proxyClientId = parseByJwtClientId(result.by_client_jwt);
		// replace old token with new token?

		try {
			const config = {
				host: `${result.proxy_config_result.auth_token}.${result.proxy_config_result.proxy_host}`, // Replace with your VPN server
				port: result.proxy_config_result.https_proxy_port,
				scheme: "https" as const, // or 'http', 'https', 'socks4'
			};

			const response = await chrome.runtime.sendMessage({
				type: "ENABLE_VPN",
				config,
			});

			if (response.success) {
				setVpnState({ enabled: true, config });
				setProxyClientId(proxyClientId);
			} else {
				setConnectError(response.error || "Failed to enable VPN");
			}
		} catch (err) {
			console.log("error enabling vpn:", err);
			setConnectError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsConnecting(false);
		}
	};

	const handleDisconnect = async () => {
		setIsDisconnecting(true);
		setConnectError(null);

		try {
			const response = await chrome.runtime.sendMessage({
				type: "DISABLE_VPN",
			});

			if (response.success) {
				setVpnState({ enabled: false, config: null });
			} else {
				setConnectError(response.error || "Failed to disable VPN");
			}

			const proxyClientId = await getProxyClientId();

			if (!proxyClientId) {
				console.log("No proxy client ID found for removal");
				return;
			}

			const removeNetworkClientResult =
				await removeNetworkClient(proxyClientId);

			if (removeNetworkClientResult.error) {
				console.error(
					"Error removing network client:",
					removeNetworkClientResult.error,
				);
			} else {
				await clearProxyClientId();
			}
		} catch (err) {
			console.error("error disabling vpn:", err);
			setConnectError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsDisconnecting(false);
		}
	};

	const handleLogout = async () => {
		setIsLoggingOut(true);

		// Disconnect VPN before logout
		if (vpnState.enabled) {
			await handleDisconnect();
		}

		await chromeStorageAdapter.removeItem("selected_connect_location");

		clearAuth();
		setIsLoggingOut(false);
	};

	const handleLocationKey = (location?: ConnectLocation): string => {
		if (!location) {
			return "best-available-provider";
		}

		if (location.country_code && location.country_code.length > 0) {
			return location.country_code;
		}

		if (location.connect_location_id?.location_id) {
			return location.connect_location_id.location_id;
		}

		return location.name ?? "";
	};

	if (isLoggingOut) {
		return (
			<Screen>
				<div className="flex w-full justify-center py-ur-2xl">
					<UrIconSpinner />
				</div>
			</Screen>
		);
	}

	return (
		<Screen>
			<div className="p-ur-md shrink-0 bg-(ur-color-black) border-b border-(--ur-color-border) relative z-10">
				<div className="mb-ur-lg">
					<div className="flex w-full justify-end">
						<UrMenu>
							<UrMenuButton>
								<UrIconHamburger className="size-6" />
							</UrMenuButton>

							<MenuItem
								className="text-left"
								onMenuItemClick={() => handleLogout()}
							>
								<UrText>Logout</UrText>
							</MenuItem>
						</UrMenu>
					</div>

					<div className="mb-ur-sm">
						{!selectedLocation && (
							<UrSelectedLocation locationKey="best-available-provider" />
						)}

						{selectedLocation && (
							<UrSelectedLocation
								key={handleLocationKey(selectedLocation)} // for React
								locationKey={handleLocationKey(selectedLocation)} // for generating color
								name={selectedLocation.name}
								providerCount={selectedLocation.provider_count}
								strongPrivacy={selectedLocation.strong_privacy}
								unstable={!selectedLocation.stable}
							/>
						)}
					</div>

					{vpnState.enabled && (
						<UrButton
							onClick={handleDisconnect}
							loading={isDisconnecting}
							variant="secondary"
							fullWidth
						>
							<UrText>{getMessage("disconnect")}</UrText>
						</UrButton>
					)}

					{!vpnState.enabled && (
						<UrButton
							onClick={() => handleConnect()}
							loading={isConnecting}
							fullWidth
						>
							<UrText>{getMessage("connect")}</UrText>
						</UrButton>
					)}

					{connectError && <UrText>{connectError}</UrText>}
					{authNetworkClientError && (
						<UrText>{authNetworkClientError.message}</UrText>
					)}
				</div>

				<UrInput
					label={getMessage("search_providers_input_label")}
					placeholder={getMessage("search_providers_input_placeholder")}
					value={query}
					onInput={(e) => setQuery(e.detail.value)}
				/>
			</div>

			{locationsLoading && (
				<div className="flex py-ur-lg justify-center">
					<UrIconSpinner size={1.2} />
				</div>
			)}

			{!locationsLoading && (
				<>
					{loadingLocationsError && (
						<div className="flex flex-col items-center justify-center py-ur-lg">
							<UrIconNetworkInstability className="color-ur-yellow-light size-ur-lg" />

							<UrText variant="small" className="mb-ur-lg text-ur-gray">
								{getMessage("something_went_wrong")}
							</UrText>

							<UrButton variant="secondary" onClick={() => retry()}>
								<UrText>{getMessage("retry")}</UrText>
							</UrButton>
						</div>
					)}

					{!loadingLocationsError && (
						<div
							id="locations-list"
							className="flex-1 overflow-y-auto pb-ur-md"
						>
							{/** "best available" */}
							{query.length == 0 && (
								<>
									<LocationsGroupLabel groupLabel={getMessage("promoted")} />
									<ul>
										<UrLocationListItem
											key={handleLocationKey()}
											locationKey={handleLocationKey()} // for generating color
											name={getMessage("best_available_provider")}
											onClick={connectBestAvailable}
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
										onSelect={connectLocation}
										handleLocationKey={handleLocationKey}
									/>
								)}

							{filteredLocations.countries &&
								filteredLocations.countries.length > 0 && (
									<LocationsGroup
										groupLabel={getMessage("countries")}
										locations={filteredLocations.countries}
										onSelect={connectLocation}
										handleLocationKey={handleLocationKey}
									/>
								)}

							{filteredLocations.cities &&
								filteredLocations.cities.length > 0 && (
									<LocationsGroup
										groupLabel={getMessage("cities")}
										locations={filteredLocations.cities}
										onSelect={connectLocation}
										handleLocationKey={handleLocationKey}
									/>
								)}

							{filteredLocations.devices &&
								filteredLocations.devices.length > 0 && (
									<LocationsGroup
										groupLabel={getMessage("devices")}
										locations={filteredLocations.devices}
										onSelect={connectLocation}
										handleLocationKey={handleLocationKey}
									/>
								)}

							{filteredLocations.regions &&
								filteredLocations.regions.length > 0 && (
									<LocationsGroup
										groupLabel={getMessage("regions")}
										locations={filteredLocations.regions}
										onSelect={connectLocation}
										handleLocationKey={handleLocationKey}
									/>
								)}
						</div>
					)}
				</>
			)}
		</Screen>
	);
};

interface LocationsGroupProps {
	groupLabel: string;
	locations: ConnectLocation[];
	onSelect: (connectLocation: ConnectLocation) => void;
	handleLocationKey: (location: ConnectLocation) => string;
}

export const LocationsGroup: React.FC<LocationsGroupProps> = ({
	groupLabel,
	locations,
	onSelect,
	handleLocationKey,
}: LocationsGroupProps) => {
	return (
		<>
			<LocationsGroupLabel groupLabel={groupLabel} />

			<ul>
				{locations.map((location) => (
					<UrLocationListItem
						key={handleLocationKey(location)}
						locationKey={handleLocationKey(location)} // for generating color
						name={location.name}
						providerCount={location.provider_count}
						onClick={() => {
							onSelect(location);
						}}
						strongPrivacy={location.strong_privacy}
						unstable={!location.stable}
					/>
				))}
			</ul>
		</>
	);
};

interface LocationsGroupLabelProps {
	groupLabel: string;
}

export const LocationsGroupLabel: React.FC<LocationsGroupLabelProps> = ({
	groupLabel,
}: LocationsGroupLabelProps) => {
	return (
		<div className="sticky top-0 bg-ur-black z-10 px-ur-md py-ur-sm text-left border-b border-t border-(--ur-color-border) shadow-md">
			<UrText variant="body">{groupLabel}</UrText>
		</div>
	);
};

export default ConnectScreen;
