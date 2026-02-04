import { MemoryRouter } from "react-router-dom";
import "./App.css";
// import { AuthContextProvider } from "./context/AuthContextProvider";
import { AppRoutes } from "./components/AppRoutes";
import { URNetworkAPIProvider } from "@urnetwork/sdk-js/react";

export default function App() {
	// const wasmUrl = chrome.runtime.getURL("wasm/sdk.wasm");
	// const wasmExecUrl = chrome.runtime.getURL("wasm/wasm_exec.js");

	return (
		<MemoryRouter>
			<URNetworkAPIProvider>
				<AppRoutes />
			</URNetworkAPIProvider>
		</MemoryRouter>
	);
}
