import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthNetworkClient, useRemoveNetworkClient } from "@urnetwork/sdk-js/react";
import { ConnectionManager, type ConnectionStatus } from "./connection-manager";
import type { ConnectLocation } from "node_modules/@urnetwork/sdk-js/dist/generated";

interface UseConnectionManagerResult {
	status: ConnectionStatus;
	error: string | null;
	connect: (location?: ConnectLocation) => Promise<void>;
	disconnect: () => Promise<void>;
	reattach: (location?: ConnectLocation) => void;
	onProxyChange: (cb: (config: null) => void) => void;
}

export function useConnectionManager(): UseConnectionManagerResult {
	const { authNetworkClient } = useAuthNetworkClient();
	const { removeNetworkClient } = useRemoveNetworkClient();

	const [status, setStatus] = useState<ConnectionStatus>("idle");
	const [error, setError] = useState<string | null>(null);

	const proxyChangeCbRef = useRef<((config: null) => void) | null>(null);
	const managerRef = useRef<ConnectionManager | null>(null);

	const authFnRef = useRef(authNetworkClient);
	const removeFnRef = useRef(removeNetworkClient);
	authFnRef.current = authNetworkClient;
	removeFnRef.current = removeNetworkClient;

	const getManager = useCallback((): ConnectionManager => {
		if (!managerRef.current) {
			managerRef.current = new ConnectionManager(
				(args) => authFnRef.current(args),
				(clientId) => removeFnRef.current(clientId),
				{
					onStatusChange: setStatus,
					onProxyChange: (config) => {
						proxyChangeCbRef.current?.(config);
					},
					onError: setError,
				},
			);
		}
		return managerRef.current;
	}, []);

	useEffect(() => {
		return () => {
			managerRef.current?.destroy();
			managerRef.current = null;
		};
	}, []);

	const connect = useCallback(
		(location?: ConnectLocation) => getManager().connect(location),
		[getManager],
	);

	const disconnect = useCallback(async () => {
		const mgr = managerRef.current;
		managerRef.current = null;
		if (mgr) {
			await mgr.disconnect();
		}
	}, []);

	const reattach = useCallback(
		(location?: ConnectLocation) => getManager().reattach(location),
		[getManager],
	);

	const onProxyChange = useCallback(
		(cb: (config: null) => void) => {
			proxyChangeCbRef.current = cb;
		},
		[],
	);

	return { status, error, connect, disconnect, reattach, onProxyChange };
}
