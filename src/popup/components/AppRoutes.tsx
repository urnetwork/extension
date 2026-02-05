import { Routes } from "react-router-dom";
import { Route } from "react-router-dom";
import AuthInitial from "./AuthInitial";
import { ConnectScreen } from "./ConnectScreen";
import AuthCreateNetwork from "./AuthCreateNetwork";
import AuthLoginUserAuth from "./AuthLoginUserAuth";
import AuthForgotPassword from "./AuthForgotPassword";
import AuthVerify from "./AuthVerify";
import { AuthFlowProvider, useAuth } from "@urnetwork/sdk-js/react";

const AuthRoutes: React.FC = () => {
	return (
		<AuthFlowProvider>
			<Routes>
				<Route path="/" element={<AuthInitial />} />
				<Route path="/create-network" element={<AuthCreateNetwork />} />
				<Route path="/login-user-auth" element={<AuthLoginUserAuth />} />
				<Route path="/forgot-password" element={<AuthForgotPassword />} />
				<Route path="/verify" element={<AuthVerify />} />
			</Routes>
		</AuthFlowProvider>
	);
};

const MainRoutes: React.FC = () => {
	return (
		<Routes>
			<Route path="/" element={<ConnectScreen />} />
		</Routes>
	);
};

export const AppRoutes: React.FC = () => {
	const { isAuthenticated } = useAuth();

	return isAuthenticated ? <MainRoutes /> : <AuthRoutes />;
};
