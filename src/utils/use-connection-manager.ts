import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionManager, type ConnectionStatus } from "./connection-manager";
import type { ConnectLocation } from "./sdk-types";

interface UseConnectionManagerResult {
	status: ConnectionStatus;
	error: string | null;
	connect: (location?: ConnectLocation) => Promise<void>;
	disconnect: () => Promise<void>;
	// logout: also removes the install's hosted proxy client
	endSession: () => Promise<void>;
	reattach: () => void;
	onProxyChange: (cb: (config: null) => void) => void;
}

export function useConnectionManager(): UseConnectionManagerResult {
	const [status, setStatus] = useState<ConnectionStatus>("idle");
	const [error, setError] = useState<string | null>(null);

	const proxyChangeCbRef = useRef<((config: null) => void) | null>(null);
	const managerRef = useRef<ConnectionManager | null>(null);

	// One manager at a time; a disconnect or logout ends it, and the next
	// action makes a new one. The background owns the connection itself
	// (utils/connection-manager.ts), so nothing is lost with a manager.
	const getManager = useCallback((): ConnectionManager => {
		if (!managerRef.current) {
			managerRef.current = new ConnectionManager({
				onStatusChange: setStatus,
				onProxyChange: (config) => {
					proxyChangeCbRef.current?.(config);
				},
				onError: setError,
			});
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
		const mgr = getManager();
		managerRef.current = null;
		await mgr.disconnect();
	}, [getManager]);

	const endSession = useCallback(async () => {
		const mgr = getManager();
		managerRef.current = null;
		await mgr.endSession();
	}, [getManager]);

	const reattach = useCallback(() => getManager().reattach(), [getManager]);

	const onProxyChange = useCallback(
		(cb: (config: null) => void) => {
			proxyChangeCbRef.current = cb;
		},
		[],
	);

	return { status, error, connect, disconnect, endSession, reattach, onProxyChange };
}
