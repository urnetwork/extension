import { proxyManager, type ProxyConfig } from "../utils/proxy-manager";

// Restore proxy state when extension starts
proxyManager.restoreState().then(() => {
	console.log("Proxy state restored");
});

// Listen for messages from the website
chrome.runtime.onMessageExternal.addListener(
	(message, sender, sendResponse) => {
		console.log("Received message from website:", message);
		console.log("Sender:", sender);

		// Verify the message is from your website
		const allowedOrigins = ["ur.io", "ur.network", "localhost"];
		if (!allowedOrigins.some((domain) => sender.url?.includes(domain))) {
			console.error("Message from unauthorized origin:", sender.url);
			sendResponse({ success: false, error: "Unauthorized origin" });
			return;
		}

		// Handle JWT authentication
		if (message.type === "SET_JWT" && message.jwt) {
			// Store the JWT using the SAME key that your SDK expects: "by_jwt"
			const storageData: { by_jwt: string; network_name?: string } = {
				by_jwt: message.jwt,
			};

			// Also store network_name if provided
			if (message.networkName) {
				storageData.network_name = message.networkName;
			}

			chrome.storage.local.set(storageData, () => {
				console.log("JWT stored successfully in by_jwt key");
				sendResponse({ success: true });

				// Optionally notify the popup if it's open
				chrome.runtime
					.sendMessage({
						type: "JWT_RECEIVED",
						jwt: message.jwt,
						networkName: message.networkName,
					})
					.catch(() => {
						// Popup might not be open, that's okay
						console.log("Popup not open to receive JWT notification");
					});
			});

			return true; // Keep the message channel open for async response
		}

		sendResponse({ success: false, error: "Unknown message type" });
		return false;
	},
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	console.log("Received internal message:", message);

	// Handle VPN enable request
	if (message.type === "ENABLE_VPN" && message.config) {
		proxyManager
			.enable(message.config as ProxyConfig)
			.then(() => {
				sendResponse({ success: true });
			})
			.catch((error) => {
				console.error("Failed to enable VPN:", error);
				sendResponse({ success: false, error: error.message });
			});
		return true; // Keep message channel open for async response
	}

	// Handle VPN disable request
	if (message.type === "DISABLE_VPN") {
		proxyManager
			.disable()
			.then(() => {
				sendResponse({ success: true });
			})
			.catch((error) => {
				console.error("Failed to disable VPN:", error);
				sendResponse({ success: false, error: error.message });
			});
		return true;
	}

	// Handle VPN state request
	if (message.type === "GET_VPN_STATE") {
		const state = proxyManager.getState();
		sendResponse({ success: true, state });
		return true;
	}

	return false;
});

console.log("URnetwork extension background script loaded");
