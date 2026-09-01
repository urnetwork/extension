import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DeviceRpcBridgeService,
	deviceRpcUrlFromSession,
	initDeviceRpcBridge,
	resolveLiveDeviceRpcSession,
	type DeviceRpcSocket,
} from "../../src/bridge/device-rpc";
import {
	DEVICE_RPC_FRAME_MAX_BYTES,
	DEVICE_RPC_PORT_NAME,
} from "../../src/bridge/protocol";
import type { BridgeSessionRecord } from "../../src/bridge/session";
import { installChromeMock } from "../chrome-mock";

const INSTANCE_ID = "11111111-2222-3333-4444-555555555555";
const RECORD: BridgeSessionRecord = {
	clientId: "client-1",
	instanceId: INSTANCE_ID,
	signedProxyId: "SECRET-SIGNED-PROXY-ID",
	proxyHost: "proxy.example.ur",
	httpsProxyPort: 8443,
	apiBaseUrl: "https://api.proxy.example.ur:8444/base?old=query#fragment",
};

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements DeviceRpcSocket {
	binaryType = "";
	readyState = 0;
	bufferedAmount = 0;
	readonly sent: Uint8Array[] = [];
	readonly closes: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<string, Listener[]>();

	send(data: Uint8Array): void {
		this.sent.push(data.slice());
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.closes.push({ code, reason });
	}

	addEventListener(type: "open" | "message" | "error" | "close", listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	open(): void {
		this.readyState = 1;
		this.emit("open", {});
	}

	message(bytes: Uint8Array): void {
		const copy = bytes.slice();
		this.emit("message", { data: copy.buffer });
	}

	error(): void {
		this.emit("error", {});
	}

	private emit(type: string, event: { data?: unknown }): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

type FakePort = {
	port: chrome.runtime.Port;
	posted: Record<string, unknown>[];
	disconnected: boolean;
	listenerCount: () => number;
	send: (frame: Record<string, unknown>) => void;
	drop: () => void;
};

function fakePort(url = "https://ur.io/app", name = DEVICE_RPC_PORT_NAME): FakePort {
	const messages: Array<(message: unknown) => void> = [];
	const disconnects: Array<() => void> = [];
	const posted: Record<string, unknown>[] = [];
	const fake: FakePort = {
		posted,
		disconnected: false,
		listenerCount: () => messages.length,
		port: {
			name,
			sender: { url },
			onMessage: { addListener: (listener: (message: unknown) => void) => messages.push(listener) },
			onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
			postMessage: (message: Record<string, unknown>) => posted.push(structuredClone(message)),
			disconnect: () => {
				fake.disconnected = true;
			},
		} as unknown as chrome.runtime.Port,
		send: (frame) => {
			for (const listener of messages) listener(frame);
		},
		drop: () => {
			for (const listener of disconnects) listener();
		},
	};
	return fake;
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function openFrame(connectionId = "connection-1"): Record<string, unknown> {
	return { dir: "device-rpc", kind: "OPEN", connectionId, instanceId: INSTANCE_ID };
}

function setup(): {
	service: DeviceRpcBridgeService;
	port: FakePort;
	sockets: FakeSocket[];
	urls: string[];
} {
	const sockets: FakeSocket[] = [];
	const urls: string[] = [];
	const service = new DeviceRpcBridgeService(
		async (instanceId) => {
			if (instanceId !== INSTANCE_ID) throw new Error("wrong instance");
			return RECORD;
		},
		(url) => {
			urls.push(url);
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
	);
	const port = fakePort();
	service.accept(port.port);
	return { service, port, sockets, urls };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("extension device-rpc bridge", () => {
	it("derives the only socket URL from extension-private session data", () => {
		expect(deviceRpcUrlFromSession(RECORD)).toBe(
			"wss://api.proxy.example.ur:8444/device-rpc?proxy=SECRET-SIGNED-PROXY-ID",
		);
		expect(() => deviceRpcUrlFromSession({ ...RECORD, apiBaseUrl: "https://evil.example/device-rpc" })).toThrow(
			"does not match",
		);
	});

	it("opens, orders, and acknowledges opaque binary frames in both directions", async () => {
		const { port, sockets, urls } = setup();
		port.send(openFrame());
		await flush();
		expect(urls).toEqual([
			"wss://api.proxy.example.ur:8444/device-rpc?proxy=SECRET-SIGNED-PROXY-ID",
		]);
		expect(sockets[0].binaryType).toBe("arraybuffer");
		sockets[0].open();
		expect(port.posted.at(-1)).toMatchObject({ kind: "OPENED", connectionId: "connection-1" });

		const outbound = Uint8Array.of(0, 1, 2, 254, 255);
		port.send({
			dir: "device-rpc",
			kind: "FRAME",
			connectionId: "connection-1",
			sequence: 1,
			data: Buffer.from(outbound).toString("base64"),
			byteLength: outbound.byteLength,
		});
		await flush();
		expect([...sockets[0].sent[0]]).toEqual([...outbound]);
		expect(port.posted.at(-1)).toMatchObject({ kind: "FRAME_SENT", sequence: 1, byteLength: 5 });

		const inbound = Uint8Array.of(9, 8, 7, 0);
		sockets[0].message(inbound);
		const received = port.posted.at(-1)!;
		expect(received).toMatchObject({ kind: "FRAME", sequence: 1, byteLength: 4 });
		expect(Buffer.from(received.data as string, "base64")).toEqual(Buffer.from(inbound));
		port.send({ dir: "device-rpc", kind: "FRAME_RECEIVED", connectionId: "connection-1", sequence: 1 });
		await flush();
	});

	it("supports zero-length SDK keepalives and also keeps the worker socket active", async () => {
		vi.useFakeTimers();
		const { port, sockets } = setup();
		port.send(openFrame());
		await flush();
		sockets[0].open();
		port.send({ dir: "device-rpc", kind: "FRAME", connectionId: "connection-1", sequence: 1, data: "", byteLength: 0 });
		await flush();
		expect(sockets[0].sent[0]).toHaveLength(0);
		vi.advanceTimersByTime(20_000);
		expect(sockets[0].sent[1]).toHaveLength(0);
	});

	it("rejects endpoint injection and never returns credentials to the page", async () => {
		const resolve = vi.fn(async () => RECORD);
		const service = new DeviceRpcBridgeService(resolve, () => new FakeSocket());
		const port = fakePort();
		service.accept(port.port);
		port.send({ ...openFrame(), url: "wss://evil.example", signedProxyId: "attacker-value" });
		await flush();
		expect(resolve).not.toHaveBeenCalled();
		expect(port.posted.at(-1)).toMatchObject({ kind: "CLOSED", reason: expect.stringContaining("extension-owned") });
		expect(JSON.stringify(port.posted)).not.toContain(RECORD.signedProxyId);
		expect(JSON.stringify(port.posted)).not.toContain(RECORD.apiBaseUrl);
	});

	it("fails closed on malformed, out-of-order, oversized, and backlogged frames", async () => {
		const cases: Array<{ name: string; mutate: (socket: FakeSocket, port: FakePort) => void }> = [
			{
				name: "malformed base64",
				mutate: (_socket, port) => port.send({ dir: "device-rpc", kind: "FRAME", connectionId: "connection-1", sequence: 1, data: "***=", byteLength: 2 }),
			},
			{
				name: "out of order",
				mutate: (_socket, port) => port.send({ dir: "device-rpc", kind: "FRAME", connectionId: "connection-1", sequence: 2, data: "", byteLength: 0 }),
			},
			{
				name: "oversized inbound",
				mutate: (socket) => socket.message(new Uint8Array(DEVICE_RPC_FRAME_MAX_BYTES + 1)),
			},
			{
				name: "outbound backlog",
				mutate: (socket, port) => {
					socket.bufferedAmount = 4 * 1024 * 1024;
					port.send({ dir: "device-rpc", kind: "FRAME", connectionId: "connection-1", sequence: 1, data: "AA==", byteLength: 1 });
				},
			},
			{
				name: "zero-byte inbound frame backlog",
				mutate: (socket) => {
					for (let i = 0; i < 65; i += 1) socket.message(new Uint8Array(0));
				},
			},
		];
		for (const testCase of cases) {
			const { port, sockets } = setup();
			port.send(openFrame());
			await flush();
			sockets[0].open();
			testCase.mutate(sockets[0], port);
			await flush();
			expect(port.posted.at(-1), testCase.name).toMatchObject({ kind: "CLOSED" });
			expect(sockets[0].closes, testCase.name).toHaveLength(1);
		}
	});

	it("isolates tabs and closes every socket on session rotation or port loss", async () => {
		const { service, port: first, sockets } = setup();
		const second = fakePort("https://app.ur.io/second");
		service.accept(second.port);
		first.send(openFrame("first"));
		second.send(openFrame("second"));
		await flush();
		sockets[0].open();
		sockets[1].open();
		first.drop();
		expect(sockets[0].closes).toHaveLength(1);
		expect(sockets[1].closes).toHaveLength(0);
		service.closeAll("session rotated");
		expect(sockets[1].closes).toHaveLength(1);
		expect(second.posted.at(-1)).toMatchObject({ kind: "CLOSED", reason: "session rotated" });
	});

	it("origin-gates the dedicated runtime port", () => {
		const chromeMock = installChromeMock();
		initDeviceRpcBridge();
		const rejected = fakePort("https://evil.example/");
		const accepted = fakePort("https://app.ur.io/");
		for (const listener of chromeMock.onConnectListeners) {
			listener(rejected.port);
			listener(accepted.port);
		}
		expect(rejected.disconnected).toBe(true);
		expect(rejected.listenerCount()).toBe(0);
		expect(accepted.disconnected).toBe(false);
		expect(accepted.listenerCount()).toBe(1);
	});

	it("requires the stored instance to match a live standard proxy session", async () => {
		const chromeMock = installChromeMock();
		chromeMock.seedStorage({ bridge_session: RECORD });
		chromeMock.setProxyValue({
			mode: "fixed_servers",
			rules: { singleProxy: { scheme: "https", host: `${RECORD.signedProxyId}.${RECORD.proxyHost}`, port: RECORD.httpsProxyPort } },
		});
		await expect(resolveLiveDeviceRpcSession(INSTANCE_ID)).resolves.toMatchObject({ instanceId: INSTANCE_ID });
		await expect(resolveLiveDeviceRpcSession("wrong-instance")).rejects.toThrow("unavailable or changed");
		chromeMock.setProxyValue({ mode: "direct" });
		await expect(resolveLiveDeviceRpcSession(INSTANCE_ID)).rejects.toThrow("not active");
	});
});
