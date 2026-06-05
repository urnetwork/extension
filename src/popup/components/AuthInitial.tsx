import React, { useEffect, useState } from "react";
import { UrButton, UrInput, UrText } from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useAuth, useAuthCodeLogin } from "@urnetwork/sdk-js/react";
import { Screen } from "./Screen";

interface JWTReceivedMessage {
	type: "JWT_RECEIVED";
	jwt: string;
	networkName?: string;
}

const AuthInitial: React.FC = () => {
	const [authCode, setAuthCode] = useState("");
	const { setAuth } = useAuth();
	const { authCodeLogin, loading, error } = useAuthCodeLogin();

	// Listen for JWT forwarded from the background script (set via external website)
	useEffect(() => {
		const messageListener = (message: JWTReceivedMessage) => {
			if (message.type === "JWT_RECEIVED" && message.jwt) {
				setAuth(message.jwt, message.networkName);
			}
		};

		chrome.runtime.onMessage.addListener(messageListener);
		return () => chrome.runtime.onMessage.removeListener(messageListener);
	}, [setAuth]);

	const handleLogin = async (e?: React.FormEvent) => {
		if (e) e.preventDefault();
		if (!authCode.trim()) return;

		try {
			const result = await authCodeLogin(authCode.trim());
			if (result.error) return; // error displayed via `error` from hook
			if (result.by_jwt) setAuth(result.by_jwt);
		} catch (err) {
			console.error("Login failed:", err);
		}
	};

	const renderInstructionsWithLink = (text: string): React.ReactNode => {
		const parts = text.split(/(\{link\}|\{\/link\})/);
		const nodes: React.ReactNode[] = [];
		let inLink = false;
		let linkBuffer: string[] = [];

		parts.forEach((part, i) => {
			if (part === "{link}") {
				inLink = true;
				linkBuffer = [];
			} else if (part === "{/link}") {
				inLink = false;
				nodes.push(
					<a
						key={i}
						href="https://ur.io"
						target="_blank"
						rel="noopener noreferrer"
						className="text-ur-blue-electric underline"
					>
						{linkBuffer.join("")}
					</a>,
				);
				linkBuffer = [];
			} else if (inLink) {
				linkBuffer.push(part);
			} else {
				nodes.push(part);
			}
		});

		return <>{nodes}</>;
	};

	return (
		<Screen>
			<div className="p-ur-md">
				<UrText variant="header" className="mt-ur-lg">
					{getMessage("stay_completely_private_and_anonymous")}
				</UrText>

				<UrText variant="subheader" className="mb-ur-2xl">
					with URnetwork
				</UrText>

				<form onSubmit={handleLogin}>
					<UrInput
						label={getMessage("auth_code_input_label")}
						placeholder={getMessage("auth_code_input_placeholder")}
						className="mb-ur-lg"
						value={authCode}
						onInput={(e) => setAuthCode(e.detail.value)}
						invalid={!!error}
						hint={error ? getMessage("auth_code_input_invalid") : undefined}
						type="password"
					/>

					<UrButton
						buttonType="submit"
						onClick={() => handleLogin()}
						loading={loading}
						disabled={loading || !authCode.trim()}
						fullWidth
						className="mb-ur-lg"
					>
						{getMessage("launch")}
					</UrButton>
				</form>

				<UrText>
					{renderInstructionsWithLink(
						getMessage("access_auth_code_instructions"),
					)}
				</UrText>

				{error && (
					<div className="mt-ur-sm">
						<UrText variant="small" className="text-ur-coral">
							{error.message}
						</UrText>
					</div>
				)}
			</div>
		</Screen>
	);
};

export default AuthInitial;
