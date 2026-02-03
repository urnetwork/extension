import React from "react";
import { Screen } from "./Screen";
import {
	UrInput,
	UrText,
	type InputChangeDetail,
} from "@urnetwork/elements/react";
import { getMessage } from "@/utils/i18n";
import { useAuth } from "../hooks/useAuth";
import { useCheckNetwork } from "@urnetwork/sdk-js/react";

const AuthCreateNetwork: React.FC = () => {
	const { userAuth } = useAuth();
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

	return (
		<Screen>
			<UrText variant="header" className="mb-ur-2xl">
				{getMessage("join_urnetwork")}
			</UrText>

			{userAuth && (
				<UrInput
					value={userAuth}
					label={getMessage("user_auth_input_label")}
					className="mb-ur-md"
					readonly
				/>
			)}

			<UrInput
				label={getMessage("network_name_input_label")}
				placeholder={getMessage("network_name_input_placeholder")}
				value={networkName}
				onChange={handleChange}
				invalid={
					(checkNetworkResult && checkNetworkResult.error != null) ||
					!!checkNetworkError
				}
				hint={
					checkNetworkError
						? getMessage("network_name_taken")
						: getMessage("network_name_input_hint")
				}
				loading={checkNetworkLoading}
			/>
		</Screen>
	);
};

export default AuthCreateNetwork;
