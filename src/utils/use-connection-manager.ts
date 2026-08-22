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

	// The ConnectionManager is created once and outlives the renders that produce
	// these two SDK callbacks, so it reads them through refs instead of capturing
	// them directly (recreating the manager would drop the live connection pool,
	// ping interval and renew timer).
	//
	// Refresh the refs from a commit, never from render. A render can be thrown
	// away, and a render-phase write would let a render that never committed
	// publish its callback into the manager -- which invokes them from timers
	// (silentRenew, scheduleReconnect) long after any render has finished. An
	// effect with no dependency array runs after every commit, which is exactly
	// the "latest committed value" semantics wanted here; the useRef seeds mean
	// there is never an empty ref before the first commit.
	const authFnRef = useRef(authNetworkClient);
	const removeFnRef = useRef(removeNetworkClient);
	useEffect(() => {
		authFnRef.current = authNetworkClient;
		removeFnRef.current = removeNetworkClient;
	});

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
