// Extension-owned transport for the SDK DeviceRemote used by ur.io.
//
// The page can open a logical connection for an expected hosted instance and
// exchange opaque, bounded binary frames. It cannot choose a URL or present a
// proxy credential: both are loaded from the extension's current live session.
import { proxyManager } from "../utils/proxy-manager";
import { isAllowedOrigin } from "../utils/origins";
import { loadBridgeSession, type BridgeSessionRecord } from "./session";
import {
	DEVICE_RPC_FRAME_MAX_BYTES,
	DEVICE_RPC_PORT_NAME,
	DEVICE_RPC_QUEUE_MAX_BYTES,
	DEVICE_RPC_QUEUE_MAX_FRAMES,
} from "./protocol";

const KEEPALIVE_MS = 20_000;
const MAX_CONNECTION_ID_LENGTH = 128;
const MAX_CONNECTIONS_PER_PORT = 8;

export type DeviceRpcPortFrame = {
	dir: "device-rpc";
	kind: "OPEN" | "FRAME" | "FRAME_RECEIVED" | "CLOSE";
	connectionId: string;
	instanceId?: string;
	sequence?: number;
	data?: string;
	byteLength?: number;
	[key: string]: unknown;
};

type DeviceRpcServiceFrame = {
	dir: "device-rpc";
	kind: "OPENED" | "FRAME" | "FRAME_SENT" | "CLOSED";
	connectionId: string;
	sequence?: number;
	data?: string;
	byteLength?: number;
	reason?: string;
};

export interface DeviceRpcSocket {
	binaryType: string;
	readonly readyState: number;
	readonly bufferedAmount: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void;
}

type ResolveSession = (expectedInstanceId: string) => Promise<BridgeSessionRecord>;
type CreateSocket = (url: string) => DeviceRpcSocket;

type ConnectionState = {
	port: chrome.runtime.Port;
	connectionId: string;
	socket: DeviceRpcSocket | null;
	closed: boolean;
	opened: boolean;
	nextOutboundSequence: number;
	nextInboundSequence: number;
	inboundOutstanding: Map<number, number>;
	inboundOutstandingBytes: number;
	keepalive: ReturnType<typeof setInterval> | null;
	remove: () => void;
};

function post(port: chrome.runtime.Port, frame: DeviceRpcServiceFrame): void {
	try {
		port.postMessage(frame);
	} catch {
		// The disconnect listener owns teardown.
	}
}

function validConnectionId(value: unknown): value is string {
	return typeof value === "string" && 0 < value.length && value.length <= MAX_CONNECTION_ID_LENGTH;
}

function validSequence(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function base64ToBytes(encoded: string, declaredLength: number): Uint8Array {
	if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || DEVICE_RPC_FRAME_MAX_BYTES < declaredLength) {
		throw new Error("invalid device rpc frame length");
	}
	if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
		throw new Error("invalid device rpc frame encoding");
	}
	let binary: string;
	try {
		binary = atob(encoded);
	} catch {
		throw new Error("invalid device rpc frame encoding");
	}
	if (binary.length !== declaredLength) {
		throw new Error("device rpc frame length mismatch");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function socketMessageBytes(data: unknown): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
	}
	throw new Error("device rpc socket delivered a non-binary frame");
}

export function deviceRpcUrlFromSession(record: BridgeSessionRecord): string {
	if (!record.apiBaseUrl) throw new Error("device rpc endpoint is unavailable");
	const url = new URL(record.apiBaseUrl);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("invalid device rpc endpoint protocol");
	}
	const expectedHost = `api.${record.proxyHost}`.toLowerCase();
	if (url.hostname.toLowerCase() !== expectedHost || url.username || url.password) {
		throw new Error("device rpc endpoint does not match the active proxy host");
	}
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/device-rpc";
	url.search = "";
	url.hash = "";
	url.searchParams.set("proxy", record.signedProxyId);
	return url.toString();
}

export async function resolveLiveDeviceRpcSession(expectedInstanceId: string): Promise<BridgeSessionRecord> {
	const [record, state] = await Promise.all([
		loadBridgeSession(),
		proxyManager.getActualProxyState(),
	]);
	if (!record || record.instanceId !== expectedInstanceId) {
		throw new Error("hosted device session is unavailable or changed");
	}
	if (!state.enabled || state.mode !== "fixed" || !state.config) {
		throw new Error("standard proxy session is not active");
	}
	const activeHost = state.config.host.toLowerCase();
	const recordedHost = `${record.signedProxyId}.${record.proxyHost}`.toLowerCase();
	if (activeHost !== recordedHost || state.config.port !== record.httpsProxyPort) {
		throw new Error("active proxy does not match the hosted device session");
	}
	// Validate before returning. The resulting URL remains extension-private.
	deviceRpcUrlFromSession(record);
	return record;
}

function productionSocket(url: string): DeviceRpcSocket {
	return new WebSocket(url) as unknown as DeviceRpcSocket;
}

export class DeviceRpcBridgeService {
	private readonly connections = new Set<ConnectionState>();
	private readonly resolveSession: ResolveSession;
	private readonly createSocket: CreateSocket;

	constructor(
		resolveSession: ResolveSession = resolveLiveDeviceRpcSession,
		createSocket: CreateSocket = productionSocket,
	) {
		this.resolveSession = resolveSession;
		this.createSocket = createSocket;
	}

	accept(port: chrome.runtime.Port): void {
		const portConnections = new Map<string, ConnectionState>();
		port.onMessage.addListener((raw: unknown) => {
			void this.handle(port, portConnections, raw).catch((error: Error) => {
				const frame = raw as Partial<DeviceRpcPortFrame> | null;
				if (validConnectionId(frame?.connectionId)) {
					const state = portConnections.get(frame.connectionId);
					if (state) this.closeState(state, error.message, true);
					else post(port, {
						dir: "device-rpc",
						kind: "CLOSED",
						connectionId: frame.connectionId,
						reason: error.message,
					});
				}
			});
		});
		port.onDisconnect.addListener(() => {
			for (const state of [...portConnections.values()]) {
				this.closeState(state, "extension transport disconnected", false);
			}
			portConnections.clear();
		});
	}

	closeAll(reason = "device session changed"): void {
		for (const state of [...this.connections]) this.closeState(state, reason, true);
	}

	private async handle(
		port: chrome.runtime.Port,
		portConnections: Map<string, ConnectionState>,
		raw: unknown,
	): Promise<void> {
		if (!raw || typeof raw !== "object") return;
		const frame = raw as DeviceRpcPortFrame;
		if (frame.dir !== "device-rpc" || !validConnectionId(frame.connectionId)) return;
		if (["url", "proxy", "proxyUrl", "signedProxyId", "apiBaseUrl", "authToken"].some((key) => key in frame)) {
			throw new Error("device rpc endpoint credentials are extension-owned");
		}

		switch (frame.kind) {
			case "OPEN": {
				if (
					typeof frame.instanceId !== "string" ||
					!frame.instanceId ||
					portConnections.has(frame.connectionId) ||
					MAX_CONNECTIONS_PER_PORT <= portConnections.size
				) {
					throw new Error("invalid or duplicate device rpc open");
				}
				const state: ConnectionState = {
					port,
					connectionId: frame.connectionId,
					socket: null,
					closed: false,
					opened: false,
					nextOutboundSequence: 1,
					nextInboundSequence: 1,
					inboundOutstanding: new Map(),
					inboundOutstandingBytes: 0,
					keepalive: null,
					remove: () => portConnections.delete(frame.connectionId),
				};
				portConnections.set(frame.connectionId, state);
				this.connections.add(state);
				try {
					const session = await this.resolveSession(frame.instanceId);
					if (state.closed) return;
					const socket = this.createSocket(deviceRpcUrlFromSession(session));
					state.socket = socket;
					socket.binaryType = "arraybuffer";
					socket.addEventListener("open", () => this.socketOpened(state));
					socket.addEventListener("message", (event) => this.socketMessage(state, event.data));
					socket.addEventListener("error", () => this.closeState(state, "device rpc socket error", true));
					socket.addEventListener("close", () => this.closeState(state, "device rpc socket closed", true));
				} catch (error) {
					this.closeState(state, (error as Error).message, true);
				}
				return;
			}
			case "FRAME": {
				const state = portConnections.get(frame.connectionId);
				if (!state || !state.opened || !state.socket || !validSequence(frame.sequence)) {
					throw new Error("device rpc connection is not open");
				}
				if (frame.sequence !== state.nextOutboundSequence || typeof frame.data !== "string" || typeof frame.byteLength !== "number") {
					throw new Error("invalid device rpc outbound sequence");
				}
				const bytes = base64ToBytes(frame.data, frame.byteLength);
				if (DEVICE_RPC_QUEUE_MAX_BYTES < state.socket.bufferedAmount + bytes.byteLength) {
					throw new Error("device rpc outbound queue limit exceeded");
				}
				state.nextOutboundSequence += 1;
				state.socket.send(bytes);
				post(port, {
					dir: "device-rpc",
					kind: "FRAME_SENT",
					connectionId: state.connectionId,
					sequence: frame.sequence,
					byteLength: bytes.byteLength,
				});
				return;
			}
			case "FRAME_RECEIVED": {
				const state = portConnections.get(frame.connectionId);
				if (!state || !validSequence(frame.sequence)) return;
				const byteLength = state.inboundOutstanding.get(frame.sequence);
				if (byteLength === undefined) throw new Error("invalid device rpc receive acknowledgement");
				state.inboundOutstanding.delete(frame.sequence);
				state.inboundOutstandingBytes -= byteLength;
				return;
			}
			case "CLOSE": {
				const state = portConnections.get(frame.connectionId);
				if (state) this.closeState(state, "closed by app", true);
				return;
			}
			default:
				throw new Error("unknown device rpc frame");
		}
	}

	private socketOpened(state: ConnectionState): void {
		if (state.closed || state.opened) return;
		state.opened = true;
		post(state.port, {
			dir: "device-rpc",
			kind: "OPENED",
			connectionId: state.connectionId,
		});
		state.keepalive = setInterval(() => {
			if (!state.closed && state.socket?.readyState === 1) {
				try {
					state.socket.send(new Uint8Array(0));
				} catch {
					this.closeState(state, "device rpc keepalive failed", true);
				}
			}
		}, KEEPALIVE_MS);
	}

	private socketMessage(state: ConnectionState, data: unknown): void {
		if (state.closed || !state.opened) return;
		try {
			const bytes = socketMessageBytes(data);
			if (DEVICE_RPC_FRAME_MAX_BYTES < bytes.byteLength) throw new Error("device rpc inbound frame limit exceeded");
			if (
				DEVICE_RPC_QUEUE_MAX_FRAMES <= state.inboundOutstanding.size ||
				DEVICE_RPC_QUEUE_MAX_BYTES < state.inboundOutstandingBytes + bytes.byteLength
			) {
				throw new Error("device rpc inbound queue limit exceeded");
			}
			const sequence = state.nextInboundSequence++;
			state.inboundOutstanding.set(sequence, bytes.byteLength);
			state.inboundOutstandingBytes += bytes.byteLength;
			post(state.port, {
				dir: "device-rpc",
				kind: "FRAME",
				connectionId: state.connectionId,
				sequence,
				data: bytesToBase64(bytes),
				byteLength: bytes.byteLength,
			});
		} catch (error) {
			this.closeState(state, (error as Error).message, true);
		}
	}

	private closeState(state: ConnectionState, reason: string, notify: boolean): void {
		if (state.closed) return;
		state.closed = true;
		this.connections.delete(state);
		state.remove();
		if (state.keepalive !== null) clearInterval(state.keepalive);
		state.keepalive = null;
		try {
			state.socket?.close(1000, "device rpc closed");
		} catch {
			// already closed
		}
		if (notify) post(state.port, {
			dir: "device-rpc",
			kind: "CLOSED",
			connectionId: state.connectionId,
			reason,
		});
	}
}

const deviceRpcBridge = new DeviceRpcBridgeService();

export function closeAllDeviceRpcConnections(reason?: string): void {
	deviceRpcBridge.closeAll(reason);
}

export function initDeviceRpcBridge(): void {
	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== DEVICE_RPC_PORT_NAME) return;
		if (!isAllowedOrigin(port.sender?.url)) {
			try {
				port.disconnect();
			} catch {
				// ignore
			}
			return;
		}
		deviceRpcBridge.accept(port);
	});
}
