import { MemoryRouter } from "react-router-dom";
import "./App.css";
import { AppRoutes } from "./components/AppRoutes";
import { chromeStorageAdapter } from "../utils/storage-adapter";
import { extensionClientInfoHeaders } from "../utils/client-info";
import { AuthProvider, URNetworkAPIProvider } from "@urnetwork/sdk/react";

// the popup's api requests carry the extension's client info, as the
// service worker's do (utils/api-client.ts)
const apiConfig = { headers: extensionClientInfoHeaders() };

export default function App() {
	// const wasmUrl = chrome.runtime.getURL("wasm/sdk.wasm");
	// const wasmExecUrl = chrome.runtime.getURL("wasm/wasm_exec.js");

	return (
		<MemoryRouter>
			<URNetworkAPIProvider config={apiConfig}>
				<AuthProvider storage={chromeStorageAdapter} onAuthChange={() => {}}>
					<AppRoutes />
				</AuthProvider>
			</URNetworkAPIProvider>
		</MemoryRouter>
	);
}
