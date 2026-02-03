import React from "react";
import { Screen } from "./Screen";
import { UrText } from "@urnetwork/elements/react";

export const ConnectScreen: React.FC = () => {
	const handleLogout = () => {
		console.log("handle logout");
	};

	return (
		<Screen>
			<UrText>Connect</UrText>
			<button onClick={() => handleLogout()}></button>
		</Screen>
	);
};
