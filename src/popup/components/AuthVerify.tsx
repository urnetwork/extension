import React from "react";
import { Screen } from "./Screen";
import { UrButton, UrInput, UrText } from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import {
	useAuth,
	useAuthFlow,
	useVerifyUserAuth,
} from "@urnetwork/sdk-js/react";
// import { useNavigate } from "react-router-dom";

const AuthVerify: React.FC = () => {
	const { verifyUserAuth, loading, error } = useVerifyUserAuth();
	const { state } = useAuthFlow();
	const { setAuth } = useAuth();
	// const { navigate } = useNavigate();
	const [code, setCode] = React.useState("");

	const handleSubmit = async (e: React.FormEvent | Event) => {
		e.preventDefault();

		if (!state.userAuth) {
			console.error("No userAuth found in state");
			return;
		}

		const result = await verifyUserAuth(state.userAuth, code);
		console.log("result is: ", result);

		if (result.error) {
			console.log("error verifying user auth: ", result.error);
			return;
		}

		if (result.network) {
			setAuth(result.network.by_jwt);

			// is this necessary? once jwt is set, router should auto update.
			// navigate("/");
		}
	};

	return (
		<Screen>
			<UrText variant="header" className="my-ur-lg">
				{getMessage("verify_screen_header")}
			</UrText>

			<UrText variant="body" color="var(ur-color-gray)" className="mb-ur-lg">
				{getMessage("verify_explanation")}
			</UrText>

			<form onSubmit={handleSubmit}>
				<UrInput
					value={code}
					onInput={(e) => setCode(e.detail.value)}
					label={getMessage("verification_input_label")}
					minLength={6}
					className="mb-ur-lg"
					hint={error ? getMessage("verify_input_invalid") : ""}
					invalid={!!error}
				/>

				<UrButton
					buttonType="submit"
					onClick={handleSubmit}
					loading={loading}
					fullWidth
				>
					{getMessage("continue")}
				</UrButton>
			</form>
		</Screen>
	);
};

export default AuthVerify;
