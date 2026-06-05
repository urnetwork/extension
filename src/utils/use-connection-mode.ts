import { useCallback, useEffect, useState } from "react";
import type { ConnectionMode } from "./connection-manager";

const STORAGE_KEY = "connection_mode";

export interface UseConnectionModeResult {
	mode: ConnectionMode;
	setMode: (mode: ConnectionMode) => void;
}

export function useConnectionMode(): UseConnectionModeResult {
	const [mode, setModeState] = useState<ConnectionMode>("standard");

	useEffect(() => {
		chrome.storage.local.get([STORAGE_KEY], (result) => {
			const stored = result[STORAGE_KEY] as ConnectionMode | undefined;
			if (stored === "multi-ip" || stored === "standard") {
				setModeState(stored);
			}
		});
	}, []);

	const setMode = useCallback((next: ConnectionMode) => {
		setModeState(next);
		chrome.storage.local.set({ [STORAGE_KEY]: next });
	}, []);

	return { mode, setMode };
}
