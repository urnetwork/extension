import React from "react";

import { UrButton, UrInput, UrText } from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useLogin } from "@urnetwork/sdk-js/react";
import { useAuth } from "../hooks/useAuth";
import { useNavigate } from "react-router-dom";
import { Screen } from "./Screen";

const AuthInitial: React.FC = () => {
	const navigate = useNavigate();
	const { userAuth, setUserAuth } = useAuth();
	const { login, loading, error } = useLogin();

	const handleLogin = async () => {
		try {
			const result = await login({ user_auth: userAuth });
			console.log("login result is: ", result);
			if (result.auth_allowed && result.auth_allowed.includes("password")) {
				console.log("navigate to userauth pass login");
				navigate("/login-user-auth");
			} else {
				console.log("result without authAllowed password is: ", result);
			}
		} catch (err) {
			console.error("Login failed:", err);
		}
	};

	return (
		<Screen>
			<UrText variant="header">
				{getMessage("stay_completely_private_and_anonymous")}
			</UrText>

			<UrText variant="subheader" className="mb-ur-2xl">
				with URnetwork
			</UrText>

			<UrInput
				label={getMessage("user_auth_input_label")}
				placeholder={getMessage("user_auth_input_placeholder")}
				className="mb-ur-lg"
				value={userAuth}
				onChange={(e) => setUserAuth(e.detail.value)}
			/>
			<UrButton fullWidth onClick={handleLogin} loading={loading}>
				{getMessage("get_started")}
			</UrButton>

			{error && <UrText variant="body">{error.message}</UrText>}
		</Screen>
	);
};

export default AuthInitial;
