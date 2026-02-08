import React, { useEffect } from "react";

import { UrButton, UrInput, UrText } from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useAuth, useAuthCodeLogin } from "@urnetwork/sdk-js/react";
import { Screen } from "./Screen";

const AuthInitial: React.FC = () => {
	const [authCode, setAuthCode] = React.useState("");
	const { setAuth } = useAuth();

	const { authCodeLogin, loading, error } = useAuthCodeLogin();
	interface JWTReceivedMessage {
		type: "JWT_RECEIVED";
		jwt: string;
		networkName?: string;
	}

	// Check for JWT from website on component mount
	useEffect(() => {
		const messageListener = (message: JWTReceivedMessage) => {
			if (message.type === "JWT_RECEIVED" && message.jwt) {
				console.log("Received JWT from website via background script");
				setAuth(message.jwt, message.networkName);
			}
		};

		chrome.runtime.onMessage.addListener(messageListener);

		return () => {
			chrome.runtime.onMessage.removeListener(messageListener);
		};
	}, [setAuth]);

	const handleLogin = async (e?: React.FormEvent | Event) => {
		if (e) e.preventDefault();
		try {
			const result = await authCodeLogin(authCode);

			if (result.error) {
				console.log("error logging in: ", result.error);
				return;
			}

			if (result.by_jwt && result.by_jwt.length > 0) {
				setAuth(result.by_jwt);
			}
		} catch (err) {
			console.error("Login failed:", err);
		}
	};

	const renderInstructionsWithLink = (text: string): React.ReactNode => {
		// Replace markers with unique tokens
		const linkStart = "___LINK_START___";
		const linkEnd = "___LINK_END___";

		const replaced = text
			.replace("{link}", linkStart)
			.replace("{/link}", linkEnd);

		const parts = replaced.split(new RegExp(`(${linkStart}|${linkEnd})`));

		const elements: React.ReactNode[] = [];
		let buffer: string[] = [];
		let inLink = false;

		parts.forEach((part, i) => {
			if (part === linkStart) {
				inLink = true;
				buffer = [];
			} else if (part === linkEnd) {
				inLink = false;
				elements.push(
					<a
						key={`link-${i}`}
						href="https://ur.io"
						target="_blank"
						rel="noopener noreferrer"
					>
						{buffer.join("")}
					</a>,
				);
				buffer = [];
			} else if (inLink) {
				buffer.push(part);
			} else {
				elements.push(part);
			}
		});

		return <>{elements}</>;
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
						onClick={handleLogin}
						loading={loading}
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

				{error && <UrText variant="body">{error.message}</UrText>}
			</div>
		</Screen>
	);
};

export default AuthInitial;
