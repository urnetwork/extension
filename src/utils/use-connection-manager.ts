import { useCallback, useEffect, useRef, useState } from "react";
import { useAuthNetworkClient, useRemoveNetworkClient } from "@urnetwork/sdk-js/react";
import { ConnectionManager, type ConnectionMode, type ConnectionStatus } from "./connection-manager";
import type { ConnectLocation } from "node_modules/@urnetwork/sdk-js/dist/generated";
import type { ProxyConfig } from "./proxy-manager";

interface UseConnectionManagerResult {
	status: ConnectionStatus;
	error: string | null;
	connect: (location?: ConnectLocation, mode?: ConnectionMode) => Promise<void>;
	disconnect: () => Promise<void>;
	reattach: (location?: ConnectLocation, mode?: ConnectionMode) => void;
	onProxyChange: (cb: (config: ProxyConfig | null) => void) => void;
}

export function useConnectionManager(): UseConnectionManagerResult {
	const { authNetworkClient } = useAuthNetworkClient();
	const { removeNetworkClient } = useRemoveNetworkClient();

	const [status, setStatus] = useState<ConnectionStatus>("idle");
	const [error, setError] = useState<string | null>(null);

	const proxyChangeCbRef = useRef<((config: ProxyConfig | null) => void) | null>(null);
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
		(location?: ConnectLocation, mode: ConnectionMode = "standard") =>
			getManager().connect(location, mode),
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
		(location?: ConnectLocation, mode: ConnectionMode = "standard") =>
			getManager().reattach(location, mode),
		[getManager],
	);

	const onProxyChange = useCallback(
		(cb: (config: ProxyConfig | null) => void) => {
			proxyChangeCbRef.current = cb;
		},
		[],
	);

	return { status, error, connect, disconnect, reattach, onProxyChange };
}
