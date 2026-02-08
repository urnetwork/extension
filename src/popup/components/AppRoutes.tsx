import { Routes } from "react-router-dom";
import { Route } from "react-router-dom";
import AuthInitial from "./AuthInitial";
import { ConnectScreen } from "./ConnectScreen";
import { useAuth } from "@urnetwork/sdk-js/react";

const AuthRoutes: React.FC = () => {
	return (
		<Routes>
			<Route path="/" element={<AuthInitial />} />
		</Routes>
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
