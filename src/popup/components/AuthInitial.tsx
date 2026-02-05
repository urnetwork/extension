import React from "react";

import { UrButton, UrInput, UrText } from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useAuthFlow } from "@urnetwork/sdk-js/react";
import { useNavigate } from "react-router-dom";
import { Screen } from "./Screen";

const AuthInitial: React.FC = () => {
	const navigate = useNavigate();
	const [userAuth, setUserAuth] = React.useState("");

	const { state, checkUserAuth } = useAuthFlow();

	const handleLogin = async (e?: React.FormEvent | Event) => {
		if (e) e.preventDefault();
		try {
			console.log("user auth is: ", userAuth);
			const result = await checkUserAuth(userAuth);

			// const result = await login({ user_auth: userAuth });
			console.log("login result is: ", result);
			if (result.auth_allowed && result.auth_allowed.includes("password")) {
				console.log("navigate to userauth pass login");
				navigate("/login-user-auth");
			} else {
				navigate("/create-network");
				console.log("result without authAllowed password is: ", result);
			}
		} catch (err) {
			console.error("Login failed:", err);
		}
	};

	return (
		<Screen>
			<UrText variant="header" className="mt-ur-lg">
				{getMessage("stay_completely_private_and_anonymous")}
			</UrText>

			<UrText variant="subheader" className="mb-ur-2xl">
				with URnetwork
			</UrText>

			<form onSubmit={handleLogin}>
				<UrInput
					label={getMessage("user_auth_input_label")}
					placeholder={getMessage("user_auth_input_placeholder")}
					className="mb-ur-lg"
					value={userAuth}
					onInput={(e) => setUserAuth(e.detail.value)}
				/>

				<UrButton
					buttonType="submit"
					onClick={handleLogin}
					loading={state.loading.checkingUserAuth}
					fullWidth
				>
					{getMessage("get_started")}
				</UrButton>
			</form>

			{state.errors.checkUserAuth && (
				<UrText variant="body">{state.errors.checkUserAuth}</UrText>
			)}
		</Screen>
	);
};

export default AuthInitial;
