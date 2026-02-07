import React, { useEffect, useState } from "react";
import { Screen } from "./Screen";
import {
	MenuItem,
	UrButton,
	UrIconHamburger,
	UrInput,
	UrMenu,
	UrMenuButton,
	UrText,
} from "@urnetwork/elements/react";
import {
	useAuth,
	useAuthNetworkClient,
	useProviderList,
} from "@urnetwork/sdk-js/react";
import type { ProxyState } from "@/utils/proxy-manager";
import { getMessage } from "@/utils/i18n";
import type {
	AuthNetworkClientArgs,
	ConnectLocation,
} from "node_modules/@urnetwork/sdk-js/dist/generated";
import { UrLocationListItem } from "@urnetwork/elements/react";
import { UrIconSpinner } from "@urnetwork/elements/react";

export const ConnectScreen: React.FC = () => {
	const { clearAuth } = useAuth();
	const {
		// loading: isAuthNetworkClientLoading,
		error: authNetworkClientError,
		authNetworkClient,
	} = useAuthNetworkClient();

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
	const [isConnectLoading, setIsConnectLoading] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);
	// const [selectedLocation, setSelectedLocation] = useState<LocationResult[]>([]);

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

	const handleConnect = async () => {
		setIsConnectLoading(true);
		setConnectError(null);

		const authParams: AuthNetworkClientArgs = {
			description: "",
			device_spec: "",
		};
		const result = await authNetworkClient(authParams);
		console.log("result is: ", result);

		// reset token to new token now?

		try {
			// TODO: Replace with your actual VPN server details
			// You might want to get this from your URnetwork API
			const config = {
				host: "your-vpn-server.com", // Replace with your VPN server
				port: 1080, // Replace with your VPN port
				scheme: "socks5" as const, // or 'http', 'https', 'socks4'
				// username: 'user', // Optional: if your VPN requires auth
				// password: 'pass', // Optional: if your VPN requires auth
			};

			const response = await chrome.runtime.sendMessage({
				type: "ENABLE_VPN",
				config,
			});

			if (response.success) {
				setVpnState({ enabled: true, config });
			} else {
				setConnectError(response.error || "Failed to enable VPN");
			}
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsConnectLoading(false);
		}
	};

	const handleDisconnect = async () => {
		setIsConnectLoading(true);
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
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsConnectLoading(false);
		}
	};

	const handleLogout = () => {
		// Disconnect VPN before logout
		if (vpnState.enabled) {
			handleDisconnect();
		}
		clearAuth();
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

					{vpnState.enabled && (
						<UrButton
							onClick={handleDisconnect}
							loading={isConnectLoading}
							variant="secondary"
							fullWidth
						>
							<UrText>{getMessage("disconnect")}</UrText>
						</UrButton>
					)}

					{!vpnState.enabled && (
						<UrButton
							onClick={handleConnect}
							loading={isConnectLoading}
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
							/>
						)}

					{filteredLocations.countries &&
						filteredLocations.countries.length > 0 && (
							<LocationsGroup
								groupLabel="Countries"
								locations={filteredLocations.countries}
							/>
						)}

					{filteredLocations.cities && filteredLocations.cities.length > 0 && (
						<LocationsGroup
							groupLabel="Cities"
							locations={filteredLocations.cities}
						/>
					)}

					{filteredLocations.devices &&
						filteredLocations.devices.length > 0 && (
							<LocationsGroup
								groupLabel="Devices"
								locations={filteredLocations.devices}
							/>
						)}

					{filteredLocations.promoted &&
						filteredLocations.promoted.length > 0 && (
							<LocationsGroup
								groupLabel="Promoted"
								locations={filteredLocations.promoted}
							/>
						)}

					{filteredLocations.regions &&
						filteredLocations.regions.length > 0 && (
							<LocationsGroup
								groupLabel="Regions"
								locations={filteredLocations.regions}
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
}

export const LocationsGroup: React.FC<LocationsGroupProps> = ({
	groupLabel,
	locations,
}: LocationsGroupProps) => {
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
							console.log("select:", location.name);
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
