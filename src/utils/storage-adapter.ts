import type { StorageAdapter } from "@urnetwork/sdk-js/react";

export const chromeStorageAdapter: StorageAdapter = {
	async getItem(key: string): Promise<string | null> {
		try {
			const result = await chrome.storage.local.get(key);
			const value = result[key];

			// Type guard: ensure it's a string or null
			if (typeof value === "string") {
				return value;
			}
			return null;
		} catch (error) {
			console.error(`Error getting ${key}:`, error);
			return null;
		}
	},

	async setItem(key: string, value: string): Promise<void> {
		try {
			await chrome.storage.local.set({ [key]: value });
		} catch (error) {
			console.error(`Error setting ${key}:`, error);
			throw error;
		}
	},

	async removeItem(key: string): Promise<void> {
		try {
			await chrome.storage.local.remove(key);
		} catch (error) {
			console.error(`Error removing ${key}:`, error);
			throw error;
		}
	},
};
