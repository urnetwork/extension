// The release list (src/utils/client-release.ts): every hosted proxy client the
// extension stops using stays written down until a remove-client call for it
// succeeds, since a client that is not removed stays active on the server,
// counting against the network's proxy cap. Before, a failed release dropped
// the client.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, type ChromeMock } from "./chrome-mock";
import {
	addPendingReleaseClients,
	pendingReleaseClientIds,
	releaseClients,
	removePendingReleaseClients,
} from "../src/utils/client-release";

describe("client release list", () => {
	let browser: ChromeMock;

	beforeEach(() => {
		browser = installChromeMock();
	});

	it("a failed release stays pending and a later pass releases it", async () => {
		const failing = vi.fn(async () => false);
		await releaseClients(["client-a"], [], failing);

		expect(failing).toHaveBeenCalledWith("client-a");
		expect(await pendingReleaseClientIds()).toEqual(["client-a"]);

		const release = vi.fn(async () => true);
		await releaseClients([], [], release);

		expect(release).toHaveBeenCalledWith("client-a");
		expect(await pendingReleaseClientIds()).toEqual([]);
		expect(browser.getStored("pending_release_clients")).toBeUndefined();
	});

	it("a rejected release counts as failed", async () => {
		await releaseClients(["client-a"], [], async () => {
			throw new Error("offline");
		});

		expect(await pendingReleaseClientIds()).toEqual(["client-a"]);
	});

	it("never releases a live client, and drops it from the list", async () => {
		await addPendingReleaseClients(["client-live", "client-old"]);
		const release = vi.fn(async () => true);

		await releaseClients([], ["client-live"], release);

		expect(release.mock.calls).toEqual([["client-old"]]);
		expect(await pendingReleaseClientIds()).toEqual([]);
	});

	it("a client taken off the list as applied is not released", async () => {
		await addPendingReleaseClients(["client-new"]);
		await removePendingReleaseClients(["client-new"]);
		const release = vi.fn(async () => true);

		await releaseClients([], [], release);

		expect(release).not.toHaveBeenCalled();
	});

	it("stops retrying after maxAttempts passes", async () => {
		const failing = vi.fn(async () => false);
		for (let i = 0; i < 3; i++) {
			await releaseClients(i === 0 ? ["client-a"] : [], [], failing, { maxAttempts: 3 });
		}

		expect(failing).toHaveBeenCalledTimes(3);
		expect(await pendingReleaseClientIds()).toEqual([]);
	});
});
