import { getMessage } from "@/utils/i18n";
import {
	UrButton,
	UrInput,
	UrText,
	UrBackButton,
} from "@urnetwork/elements/react";
import React, { useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { Screen } from "./Screen";
import { useNavigate } from "react-router-dom";
import { useLoginWithPassword } from "@urnetwork/sdk-js/react";

const AuthLoginUserAuth: React.FC = () => {
	const { userAuth } = useAuth();
	const [password, setPassword] = useState("");
	const navigate = useNavigate();
	const { login, loading, error } = useLoginWithPassword();

	const handleLogin = async () => {
		const result = await login({ user_auth: userAuth, password });
		console.log("login with password result is: ", result);
		// todo - navigate to connect on success
		// todo - prompt error message if failed
	};

	return (
		<Screen>
			<div className="w-full flex justify-start mb-ur-2xl">
				<UrBackButton onClick={() => navigate(-1)} />
			</div>

			<UrText variant="header" className="mb-ur-2xl">
				{getMessage("its_nice_to_see_you_again")}
			</UrText>

			<UrInput
				label={getMessage("user_auth_input_label")}
				value={userAuth}
				className="mb-ur-md"
				readonly
			/>

			<UrInput
				value={password}
				onChange={(e) => setPassword(e.detail.value)}
				type="password"
				label={getMessage("password")}
				placeholder="********"
				className="mb-ur-lg"
			/>

			<UrButton
				fullWidth
				onClick={handleLogin}
				className="mb-ur-lg"
				loading={loading}
			>
				{getMessage("continue")}
			</UrButton>

			{error && (
				<UrText
					variant="body"
					color="var(--ur-color-danger)"
					className="mb-ur-lg"
				>
					{error.message}
				</UrText>
			)}

			<div className="flex full-width">
				<UrText variant="body" color="var(--ur-color-gray)">
					{getMessage("forgot_your_password")}
				</UrText>
				<button className="cursor-pointer ml-ur-sm">
					<UrText variant="body" color="var(--ur-color-white)">
						{getMessage("reset_it")}
					</UrText>
				</button>
			</div>
		</Screen>
	);
};

export default AuthLoginUserAuth;
