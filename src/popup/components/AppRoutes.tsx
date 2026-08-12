import React from "react";
import { Routes, Route } from "react-router-dom";
import AuthInitial from "./AuthInitial";
import { ConnectScreen } from "./ConnectScreen";
import { useAuth } from "@urnetwork/sdk-js/react";

interface AppRoutesProps {
	onApiChange?: () => void;
}

const AuthRoutes: React.FC<{ onApiChange?: () => void }> = ({ onApiChange }) => (
	<Routes>
		<Route path="/" element={<AuthInitial onApiChange={onApiChange} />} />
	</Routes>
);

const MainRoutes: React.FC = () => (
	<Routes>
		<Route path="/" element={<ConnectScreen />} />
	</Routes>
);

export const AppRoutes: React.FC<AppRoutesProps> = ({ onApiChange }) => {
	const { isAuthenticated } = useAuth();
	return isAuthenticated ? <MainRoutes /> : <AuthRoutes onApiChange={onApiChange} />;
};
