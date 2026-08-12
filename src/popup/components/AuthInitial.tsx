import React, { useEffect, useState } from "react";
import { UrButton, UrInput, UrText } from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useAuth, useAuthCodeLogin } from "@urnetwork/sdk-js/react";
import { getStoredApiHost, setStoredApiHost, getDefaultApiHost } from "@/utils/api-config";

interface JWTReceivedMessage {
	type: "JWT_RECEIVED";
	jwt: string;
	networkName?: string;
}

interface AuthInitialProps {
	onApiChange?: () => void;
}

const AuthInitial: React.FC<AuthInitialProps> = ({ onApiChange }) => {
	const [authCode, setAuthCode] = useState("");
	const [ssoLoading, setSsoLoading] = useState(false);
	const { setAuth } = useAuth();
	const { authCodeLogin, loading, error } = useAuthCodeLogin();

	const [showApiConfig, setShowApiConfig] = useState(false);
	const [apiHost, setApiHost] = useState(getDefaultApiHost());
	const [apiHostInput, setApiHostInput] = useState("");
	const [apiSaving, setApiSaving] = useState(false);

	useEffect(() => {
		getStoredApiHost().then((host) => {
			setApiHost(host);
			setApiHostInput(host);
		});
	}, []);

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
			if (result.error) return;
			if (result.by_jwt) setAuth(result.by_jwt);
		} catch (err) {
			console.error("Login failed:", err);
		}
	};

	const handleSsoLogin = async () => {
		setSsoLoading(true);
		try {
			const response = await chrome.runtime.sendMessage({ type: "START_SSO" });
			if (!response?.success) {
				console.error("SSO failed:", response?.error);
			}
		} catch (err) {
			console.error("Failed to initiate SSO:", err);
		} finally {
			setSsoLoading(false);
		}
	};

	const handleSaveApiHost = async () => {
		const trimmed = apiHostInput.trim();
		if (!trimmed) return;
		setApiSaving(true);
		try {
			await setStoredApiHost(trimmed);
			const resolved = trimmed === getDefaultApiHost() ? getDefaultApiHost() : trimmed;
			setApiHost(resolved);
			setShowApiConfig(false);
			onApiChange?.();
		} finally {
			setApiSaving(false);
		}
	};

	const handleResetApiHost = async () => {
		setApiSaving(true);
		try {
			await setStoredApiHost(getDefaultApiHost());
			setApiHost(getDefaultApiHost());
			setApiHostInput(getDefaultApiHost());
			setShowApiConfig(false);
			onApiChange?.();
		} finally {
			setApiSaving(false);
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
						className="text-ur-blue-electric hover:underline"
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
		<div className="h-full w-full flex items-center justify-center" style={{ background: "var(--color-surface-0)" }}>
			<div className="w-full max-w-[300px] text-center">
				{/* Logo */}
				<div className="flex justify-center mb-6">
					<img src="/logo.png" alt="URnetwork" className="h-12 w-12 rounded-xl" />
				</div>

				<h1 className="text-lg font-semibold mb-1">
					{getMessage("stay_completely_private_and_anonymous")}
				</h1>
				<p className="text-sm opacity-50 mb-6">with URnetwork</p>

				{/* SSO Login button */}
				<UrButton
					onClick={handleSsoLogin}
					loading={ssoLoading}
					disabled={ssoLoading}
					fullWidth
					className="mb-4"
				>
					Login with SSO
				</UrButton>

				{/* Divider */}
				<div className="flex items-center gap-3 mb-4">
					<div className="flex-1 h-px opacity-15" style={{ background: "white" }} />
					<span className="text-xs opacity-40">or</span>
					<div className="flex-1 h-px opacity-15" style={{ background: "white" }} />
				</div>

				{/* Manual auth code form */}
				<form onSubmit={handleLogin} className="text-left">
					<label className="block text-sm font-medium opacity-70 mb-1.5">
						{getMessage("auth_code_input_label")}
					</label>
					<div className="mb-4 rounded-xl overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
						<UrInput
							placeholder={getMessage("auth_code_input_placeholder")}
							value={authCode}
							onInput={(e) => setAuthCode(e.detail.value)}
							invalid={!!error}
							hint={error ? getMessage("auth_code_input_invalid") : undefined}
							type="password"
						/>
					</div>

					<UrButton
						buttonType="submit"
						onClick={() => handleLogin()}
						loading={loading}
						disabled={loading || !authCode.trim()}
						fullWidth
						variant="secondary"
						className="mb-4"
					>
						{getMessage("launch")}
					</UrButton>
				</form>

				<p className="text-xs opacity-60 leading-relaxed">
					{renderInstructionsWithLink(getMessage("access_auth_code_instructions"))}
				</p>

				{error && (
					<div className="mt-3">
						<UrText variant="small" className="text-ur-coral">
							{error.message}
						</UrText>
					</div>
				)}

				{/* Change Network API section */}
				<div className="mt-6 pt-4 border-t border-white/10">
					{!showApiConfig ? (
						<button
							type="button"
							onClick={() => {
								setApiHostInput(apiHost);
								setShowApiConfig(true);
							}}
							className="text-[11px] opacity-40 hover:opacity-70 transition-opacity cursor-pointer"
						>
							{apiHost !== getDefaultApiHost()
								? `Network API: ${apiHost}`
								: "Change Network API"}
						</button>
					) : (
						<div className="text-left">
							<label className="block text-[11px] font-medium opacity-50 mb-1.5">
								Network API Host
							</label>
							<div className="mb-2 rounded-xl overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
								<UrInput
									placeholder="api.ur.network"
									value={apiHostInput}
									onInput={(e) => setApiHostInput(e.detail.value)}
								/>
							</div>
							<div className="flex gap-2">
								<UrButton
									onClick={handleSaveApiHost}
									loading={apiSaving}
									disabled={apiSaving || !apiHostInput.trim()}
									fullWidth
									variant="secondary"
								>
									Save
								</UrButton>
								{apiHost !== getDefaultApiHost() && (
									<UrButton
										onClick={handleResetApiHost}
										loading={apiSaving}
										disabled={apiSaving}
										variant="secondary"
									>
										Reset
									</UrButton>
								)}
								<button
									type="button"
									onClick={() => setShowApiConfig(false)}
									className="text-xs opacity-50 hover:opacity-80 px-2"
								>
									Cancel
								</button>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};

export default AuthInitial;
