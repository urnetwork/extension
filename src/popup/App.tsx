import { useState, useEffect, useCallback } from "react";
import { MemoryRouter } from "react-router-dom";
import "./App.css";
import { AppRoutes } from "./components/AppRoutes";
import { chromeStorageAdapter } from "../utils/storage-adapter";
import { AuthProvider, URNetworkAPIProvider } from "@urnetwork/sdk-js/react";
import { getStoredApiHost, buildApiBaseUrl } from "../utils/api-config";

export default function App() {
	const [apiBaseUrl, setApiBaseUrl] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);

	useEffect(() => {
		getStoredApiHost().then((host) => {
			setApiBaseUrl(buildApiBaseUrl(host));
		});
	}, [refreshKey]);

	const handleApiChange = useCallback(() => {
		setRefreshKey((k) => k + 1);
	}, []);

	if (!apiBaseUrl) return null;

	return (
		<MemoryRouter>
			<URNetworkAPIProvider key={refreshKey} config={{ baseURL: apiBaseUrl }}>
				<AuthProvider storage={chromeStorageAdapter} onAuthChange={() => {}}>
					<AppRoutes onApiChange={handleApiChange} />
				</AuthProvider>
			</URNetworkAPIProvider>
		</MemoryRouter>
	);
}
