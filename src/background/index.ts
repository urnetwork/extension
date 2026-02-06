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

console.log("URnetwork extension background script loaded");
