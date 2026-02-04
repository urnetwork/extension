import React, { useState } from "react";
import { Screen } from "./Screen";
import {
	UrBackButton,
	UrButton,
	UrInput,
	UrText,
	type InputChangeDetail,
} from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useAuthFlow, useCheckNetwork } from "@urnetwork/sdk-js/react";
import { useNavigate } from "react-router-dom";

const AuthCreateNetwork: React.FC = () => {
	const [password, setPassword] = useState("");
	// const [formValid, setFormValid] = useState(false);
	const [termsAgreed, setTermsAgreed] = useState(false);

	const { state, createNetwork } = useAuthFlow();
	const navigate = useNavigate();
	const {
		checkNetwork,
		loading: checkNetworkLoading,
		error: checkNetworkError,
		result: checkNetworkResult,
	} = useCheckNetwork();
	const [networkName, setNetworkName] = React.useState("");

	const handleChange = (e: CustomEvent<InputChangeDetail>) => {
		const value = e.detail.value;
		setNetworkName(value);
		checkNetwork({ network_name: value });
	};

	const handleSubmit = async (e: React.FormEvent | Event) => {
		e.preventDefault();
		if (!termsAgreed) {
			return;
		}

		const result = await createNetwork({
			networkName: networkName,
			password: password || undefined,
			terms: termsAgreed,
		});
		console.log("create network result is: ", result);

		if (result.error) {
			console.log("error creating network: ", result.error);
			// todo - show error message
			return;
		}

		if (result.verification_required) {
			navigate("/verify");
			return;
		}

		if (result.network?.by_jwt) {
			// todo - auth and enter app
		}
	};

	const isNetworkNameInvalid = () => {
		return (
			(checkNetworkResult && !checkNetworkResult.available) ||
			!!checkNetworkError
		);
	};

	const isFormValid = () => {
		if (!termsAgreed) return false;
		if (networkName.length < 6) return false;
		if (!checkNetworkResult) return false;
		if (!checkNetworkResult.available) return false;

		// only need to validate pass if creating network with userAuth
		if (state.userAuth && password.length < 12) return false;

		return true;
	};

	const renderTermsCheckbox = (text: string): React.ReactNode => {
		// Replace markers with unique tokens
		const termsStart = "___TERMS_START___";
		const termsEnd = "___TERMS_END___";
		const privacyStart = "___PRIVACY_START___";
		const privacyEnd = "___PRIVACY_END___";

		const replaced = text
			.replace("{terms_start}", termsStart)
			.replace("{terms_end}", termsEnd)
			.replace("{privacy_start}", privacyStart)
			.replace("{privacy_end}", privacyEnd);

		const parts = replaced.split(
			new RegExp(`(${termsStart}|${termsEnd}|${privacyStart}|${privacyEnd})`),
		);

		const elements: React.ReactNode[] = [];
		let buffer: string[] = [];
		let inTerms = false;
		let inPrivacy = false;

		parts.forEach((part, i) => {
			if (part === termsStart) {
				inTerms = true;
				buffer = [];
			} else if (part === termsEnd) {
				inTerms = false;
				elements.push(
					<a
						key={`terms-link-${i}`}
						href="https://ur.io/terms"
						target="_blank"
						rel="noopener noreferrer"
					>
						{buffer.join("")}
					</a>,
				);
				buffer = [];
			} else if (part === privacyStart) {
				inPrivacy = true;
				buffer = [];
			} else if (part === privacyEnd) {
				inPrivacy = false;
				elements.push(
					<a
						key={`privacy-link-${i}`}
						href="https://ur.io/privacy"
						target="_blank"
						rel="noopener noreferrer"
					>
						{buffer.join("")}
					</a>,
				);
				buffer = [];
			} else if (inTerms || inPrivacy) {
				buffer.push(part);
			} else {
				elements.push(part);
			}
		});

		return <>{elements}</>;
	};

	return (
		<Screen>
			<div className="w-full flex justify-start mb-ur-2xl">
				<UrBackButton onClick={() => navigate(-1)} />
			</div>

			<UrText variant="header" className="mb-ur-2xl">
				{getMessage("join_urnetwork")}
			</UrText>

			<form onSubmit={handleSubmit}>
				{state.userAuth && (
					<UrInput
						value={state.userAuth}
						label={getMessage("user_auth_input_label")}
						className="mb-ur-md"
						readonly
					/>
				)}

				<UrInput
					className="mb-ur-md"
					label={getMessage("network_name_input_label")}
					placeholder={getMessage("network_name_input_placeholder")}
					value={networkName}
					onInput={handleChange}
					invalid={isNetworkNameInvalid()}
					// hint={
					// 	checkNetworkResult && !checkNetworkResult.available
					// 		? getMessage("network_name_taken")
					// 		: getMessage("network_name_input_hint")
					// }
					hint={
						checkNetworkResult
							? checkNetworkResult.available
								? ""
								: getMessage("network_name_taken")
							: getMessage("network_name_input_hint")
					}
					loading={checkNetworkLoading}
					minLength={6}
					required
				/>

				{state.userAuth && (
					<UrInput
						className="mb-ur-md"
						type="password"
						value={password}
						onInput={(e) => setPassword(e.detail.value)}
						label={getMessage("password")}
						placeholder="********"
						hint={getMessage("password_input_length_hint")}
						minLength={12}
					/>
				)}

				<label className="flex mb-ur-md justify-center items-start">
					<input
						type="checkbox"
						checked={termsAgreed}
						onChange={() => setTermsAgreed((prev) => !prev)}
						className="mt-ur-sm"
					/>
					<UrText variant="small" className="pl-ur-sm text-left">
						{renderTermsCheckbox(getMessage("terms_checkbox"))}
					</UrText>
				</label>

				<UrButton
					buttonType="submit"
					onClick={handleSubmit}
					fullWidth
					disabled={!isFormValid()}
				>
					{getMessage("continue")}
				</UrButton>
			</form>
		</Screen>
	);
};

export default AuthCreateNetwork;
