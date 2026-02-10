import { MemoryRouter } from "react-router-dom";
import "./App.css";
import { AppRoutes } from "./components/AppRoutes";
import { chromeStorageAdapter } from "../utils/storage-adapter";
import { AuthProvider, URNetworkAPIProvider } from "@urnetwork/sdk-js/react";

export default function App() {
	// const wasmUrl = chrome.runtime.getURL("wasm/sdk.wasm");
	// const wasmExecUrl = chrome.runtime.getURL("wasm/wasm_exec.js");

	return (
		<MemoryRouter>
			<URNetworkAPIProvider>
				<AuthProvider storage={chromeStorageAdapter} onAuthChange={() => null}>
					<AppRoutes />
				</AuthProvider>
			</URNetworkAPIProvider>
		</MemoryRouter>
	);
}
