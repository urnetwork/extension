import { Routes } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Route } from "react-router-dom";
import AuthInitial from "./AuthInitial";
import { Connect } from "./Connect";
import AuthCreateNetwork from "./AuthCreateNetwork";
import AuthLoginUserAuth from "./AuthLoginUserAuth";
import AuthForgotPassword from "./AuthForgotPassword";
import AuthVerify from "./AuthVerify";

const AuthRoutes: React.FC = () => {
	return (
		<Routes>
			<Route path="/" element={<AuthInitial />} />
			<Route path="/create-network" element={<AuthCreateNetwork />} />
			<Route path="/login-user-auth" element={<AuthLoginUserAuth />} />
			<Route path="/forgot-password" element={<AuthForgotPassword />} />
			<Route path="/verify" element={<AuthVerify />} />
		</Routes>
	);
};

const MainRoutes: React.FC = () => {
	return (
		<Routes>
			<Route path="/" element={<Connect />} />
		</Routes>
	);
};

export const AppRoutes: React.FC = () => {
	const { token } = useAuth();

	return token ? <MainRoutes /> : <AuthRoutes />;
};
