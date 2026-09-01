import { beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_PORT_NAME, DEVICE_RPC_PORT_NAME } from "../../src/bridge/protocol";

type FakePort = {
	port: chrome.runtime.Port;
	posted: Record<string, unknown>[];
	emit: (message: Record<string, unknown>) => void;
	drop: () => void;
};

function fakePort(name: string): FakePort {
	const messages: Array<(message: Record<string, unknown>) => void> = [];
	const disconnects: Array<() => void> = [];
	const posted: Record<string, unknown>[] = [];
	return {
		posted,
		port: {
			name,
			onMessage: { addListener: (listener: (message: Record<string, unknown>) => void) => messages.push(listener) },
			onDisconnect: { addListener: (listener: () => void) => disconnects.push(listener) },
			postMessage: (message: Record<string, unknown>) => posted.push(structuredClone(message)),
		} as unknown as chrome.runtime.Port,
		emit: (message) => {
			for (const listener of messages) listener(message);
		},
		drop: () => {
			for (const listener of disconnects) listener();
		},
	};
}

class FakeWindow {
	location = { origin: "https://ur.io" };
	posts: Array<{ message: Record<string, unknown>; origin: string }> = [];
	listeners: Array<(event: Record<string, unknown>) => void> = [];

	addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
		if (type === "message") this.listeners.push(listener);
	}

	postMessage(message: Record<string, unknown>, origin: string): void {
		this.posts.push({ message: structuredClone(message), origin });
	}

	deliver(data: Record<string, unknown>, origin = this.location.origin, source: unknown = this): void {
		for (const listener of this.listeners) listener({ data, origin, source });
	}
}

describe("content-script device-rpc relay", () => {
	let windowObject: FakeWindow;
	let ports: Map<string, FakePort[]>;

	beforeEach(async () => {
		vi.resetModules();
		windowObject = new FakeWindow();
		ports = new Map();
		vi.stubGlobal("window", windowObject);
		vi.stubGlobal("document", { documentElement: { dataset: {} } });
		vi.stubGlobal("chrome", {
			runtime: {
				id: "extension-id",
				lastError: undefined,
				getManifest: () => ({ version: "1.2.3" }),
				connect: ({ name }: { name: string }) => {
					const value = fakePort(name);
					ports.set(name, [...(ports.get(name) ?? []), value]);
					return value.port;
				},
			},
		});
		await import("../../src/bridge/content");
	});

	it("uses a dedicated Port and strips every page-supplied endpoint field", () => {
		expect(ports.get(BRIDGE_PORT_NAME)).toHaveLength(1);
		windowObject.deliver({
			urnb: 1,
			dir: "device-rpc",
			kind: "OPEN",
			connectionId: "c-1",
			instanceId: "instance-1",
			url: "wss://evil.example",
			signedProxyId: "page-secret",
		});
		const devicePort = ports.get(DEVICE_RPC_PORT_NAME)?.[0];
		expect(devicePort).toBeDefined();
		expect(devicePort!.posted).toEqual([{
			dir: "device-rpc",
			kind: "OPEN",
			connectionId: "c-1",
			instanceId: "instance-1",
		}]);
	});

	it("relays service frames with page markers and reports Port loss", () => {
		windowObject.deliver({ urnb: 1, dir: "device-rpc", kind: "OPEN", connectionId: "c-1", instanceId: "instance-1" });
		const devicePort = ports.get(DEVICE_RPC_PORT_NAME)![0];
		devicePort.emit({ dir: "device-rpc", kind: "OPENED", connectionId: "c-1" });
		expect(windowObject.posts.at(-1)?.message).toEqual({
			urnb: 1,
			from: "urnetwork-extension",
			dir: "device-rpc",
			kind: "OPENED",
			connectionId: "c-1",
		});
		devicePort.drop();
		expect(windowObject.posts.at(-1)?.message).toMatchObject({
			dir: "device-rpc",
			kind: "CLOSED",
			connectionId: "c-1",
			reason: expect.stringContaining("disconnected"),
		});
	});

	it("rejects wrong-window, cross-origin, and malformed page frames", () => {
		const frame = { urnb: 1, dir: "device-rpc", kind: "OPEN", connectionId: "c-1", instanceId: "instance-1" };
		windowObject.deliver(frame, "https://evil.example");
		windowObject.deliver(frame, windowObject.location.origin, {});
		windowObject.deliver({ ...frame, instanceId: "" });
		expect(ports.get(DEVICE_RPC_PORT_NAME)).toBeUndefined();
	});
});
