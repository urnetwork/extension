import { getMessage } from "@/utils/i18n";
import { UrInput, UrText } from "@urnetwork/elements/react";
import React from "react";
import { useAuth } from "../hooks/useAuth";

const AuthLoginUserAuth: React.FC = () => {
	const { userAuth } = useAuth();

	return (
		<div className="min-h-screen flex flex-col items-center justify-center w-full">
			<UrText variant="header" className="mb-ur-2xl">
				{getMessage("its_nice_to_see_you_again")}
			</UrText>

			<UrInput readonly value={userAuth} />
		</div>
	);
};

export default AuthLoginUserAuth;
