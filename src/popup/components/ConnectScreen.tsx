import React, { useEffect, useState } from "react";
import { Screen } from "./Screen";
import {
	MenuItem,
	UrButton,
	UrIconHamburger,
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
	const {
		// loading: isAuthNetworkClientLoading,
		error: authNetworkClientError,
		authNetworkClient,
	} = useAuthNetworkClient();

	const { removeNetworkClient } = useRemoveNetworkClient();

	const {
		query,
		setQuery,
		filteredLocations,
		loading: locationsLoading,
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

		loadVpnState();
	}, []);

	const connectLocation = (location: ConnectLocation) => {
		setSelectedLocation(location);
		// todo - should set in storage manager as well to persist selected location

		handleConnect(location);
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

		const authParams: AuthNetworkClientArgs = {
			description: "",
			device_spec: "",
		};

		const locationForConnection = connectLocation ?? selectedLocation;

		if (locationForConnection) {
			authParams.proxy_config = {
				lock_caller_ip: false,
				lock_ip_list: [],
				enable_socks: true,
				enable_http: true,
				http_require_auth: false,
				initial_device_state: {
					location: {
						connect_location_id: {
							location_id:
								locationForConnection.connect_location_id?.location_id,
						},
						stable: true, // todo - these should be optional in the SDK
						strong_privacy: true, // todo - these should be optional in the SDK
					},
					performance_profile: null,
				},
			};
		}

		const result = await authNetworkClient(authParams);
		console.log("authNetworkClient result is: ", result);

		if (result.error) {
			console.error("Auth network client error:", result.error);
			setConnectError(result.error.message);
			setIsConnecting(false);
			return;
		}

		if (!result.by_client_jwt) {
			console.log("No client JWT returned");
			setConnectError("Authentication failed: No client token received");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result) {
			console.log("No proxy config result returned");
			setConnectError("No proxy configuration available");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result.auth_token) {
			console.log("No auth token in proxy config result");
			setConnectError("No authentication token available for VPN");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result.proxy_host) {
			console.log("No proxy host in proxy config result");
			setConnectError("No proxy host available for VPN");
			setIsConnecting(false);
			return;
		}

		if (!result.proxy_config_result.https_proxy_port) {
			console.log("No proxy port in proxy config result");
			setConnectError("No proxy port available for VPN");
			setIsConnecting(false);
			return;
		}

		const proxyClientId = parseByJwtClientId(result.by_client_jwt);
		console.log("proxyClientId: ", proxyClientId);
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
				// todo - remove network client
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
			console.log(
				"remove network client result is: ",
				removeNetworkClientResult,
			);

			if (removeNetworkClientResult.error) {
				console.error(
					"Error removing network client:",
					removeNetworkClientResult.error,
				);
			} else {
				console.log("Network client removed successfully");
				await clearProxyClientId();
			}
		} catch (err) {
			console.log("error disabling vpn:", err);
			setConnectError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsDisconnecting(false);
		}
	};

	const handleLogout = () => {
		// Disconnect VPN before logout
		if (vpnState.enabled) {
			handleDisconnect();
		}
		clearAuth();
	};

	const handleLocationKey = (location: ConnectLocation): string => {
		if (location.country_code && location.country_code.length > 0) {
			return location.country_code;
		}

		if (location.connect_location_id?.location_id) {
			return location.connect_location_id.location_id;
		}

		return location.name ?? "";
	};

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
					label="Search Providers"
					placeholder="Search countries, states, cities..."
					value={query}
					onInput={(e) => setQuery(e.detail.value)}
				/>
			</div>

			{locationsLoading && (
				<div className="flex py-ur-lg justify-center">
					<UrIconSpinner />
				</div>
			)}

			{!locationsLoading && (
				<div id="locations-list" className="flex-1 overflow-y-auto pb-ur-md">
					{filteredLocations.best_matches &&
						filteredLocations.best_matches.length > 0 && (
							<LocationsGroup
								groupLabel="Best Matches"
								locations={filteredLocations.best_matches}
								onSelect={connectLocation}
								handleLocationKey={handleLocationKey}
							/>
						)}

					{filteredLocations.countries &&
						filteredLocations.countries.length > 0 && (
							<LocationsGroup
								groupLabel="Countries"
								locations={filteredLocations.countries}
								onSelect={connectLocation}
								handleLocationKey={handleLocationKey}
							/>
						)}

					{filteredLocations.cities && filteredLocations.cities.length > 0 && (
						<LocationsGroup
							groupLabel="Cities"
							locations={filteredLocations.cities}
							onSelect={connectLocation}
							handleLocationKey={handleLocationKey}
						/>
					)}

					{filteredLocations.devices &&
						filteredLocations.devices.length > 0 && (
							<LocationsGroup
								groupLabel="Devices"
								locations={filteredLocations.devices}
								onSelect={connectLocation}
								handleLocationKey={handleLocationKey}
							/>
						)}

					{filteredLocations.promoted &&
						filteredLocations.promoted.length > 0 && (
							<LocationsGroup
								groupLabel="Promoted"
								locations={filteredLocations.promoted}
								onSelect={connectLocation}
								handleLocationKey={handleLocationKey}
							/>
						)}

					{filteredLocations.regions &&
						filteredLocations.regions.length > 0 && (
							<LocationsGroup
								groupLabel="Regions"
								locations={filteredLocations.regions}
								onSelect={connectLocation}
								handleLocationKey={handleLocationKey}
							/>
						)}
				</div>
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
			<div className="sticky top-0 bg-ur-black z-10 px-ur-md py-ur-sm text-left border-b border-(--ur-color-border) shadow-md">
				<UrText variant="body">{groupLabel}</UrText>
			</div>

			<ul>
				{locations.map((location) => (
					<UrLocationListItem
						key={handleLocationKey(location)} // for React
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

export default ConnectScreen;
