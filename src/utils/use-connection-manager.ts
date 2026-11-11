import { useCallback, useEffect, useRef, useState } from "react";
import {
	ConnectionManager,
	type BlockedProxy,
	type ConnectResult,
	type ConnectionStatus,
	type OutOfBalanceAlert,
} from "./connection-manager";
import type { ProxyView } from "./proxy-control";
import type { ConnectLocation } from "./sdk-types";

interface UseConnectionManagerResult {
	// "loading" until the background says how the proxy stands
	status: ConnectionStatus;
	error: string | null;
	// the out-of-data alert, kept after a disconnect from it
	outOfBalance: OutOfBalanceAlert | null;
	// who keeps the proxy setting from the extension
	blocked: BlockedProxy | null;
	connect: (location?: ConnectLocation) => Promise<ConnectResult>;
	disconnect: () => Promise<void>;
	// logout: also removes the install's hosted proxy client
	endSession: () => Promise<void>;
	// the popup opened: `view` is the proxy as GET_VPN_STATE reports it, null
	// when the background could not say
	reattach: (view: ProxyView | boolean | null) => Promise<void>;
	onProxyChange: (cb: (config: null) => void) => void;
}

export function useConnectionManager(): UseConnectionManagerResult {
	const [status, setStatus] = useState<ConnectionStatus>("loading");
	const [error, setError] = useState<string | null>(null);
	const [outOfBalance, setOutOfBalance] = useState<OutOfBalanceAlert | null>(null);
	const [blocked, setBlocked] = useState<BlockedProxy | null>(null);

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
				onOutOfBalance: setOutOfBalance,
				onBlocked: setBlocked,
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
		(location?: ConnectLocation) => {
			// a new manager starts from loading; a connect leaves it at once
			const mgr = getManager();
			setOutOfBalance(null);
			setBlocked(null);
			return mgr.connect(location);
		},
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
		setOutOfBalance(null);
		await mgr.endSession();
	}, [getManager]);

	const reattach = useCallback(
		(view: ProxyView | boolean | null) => getManager().reattach(view),
		[getManager],
	);

	const onProxyChange = useCallback(
		(cb: (config: null) => void) => {
			proxyChangeCbRef.current = cb;
		},
		[],
	);

	return { status, error, outOfBalance, blocked, connect, disconnect, endSession, reattach, onProxyChange };
}
