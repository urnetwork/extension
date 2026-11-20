import React, { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import AuthInitial from "./AuthInitial";
import { ConnectScreen } from "./ConnectScreen";
import { LicensesScreen } from "./LicensesScreen";
import { useAuth } from "@urnetwork/sdk/react";
import { onSignedOut } from "@/utils/code-sign-in";

const AuthRoutes: React.FC = () => (
	<Routes>
		<Route path="/" element={<AuthInitial />} />
	</Routes>
);

const MainRoutes: React.FC = () => (
	<Routes>
		<Route path="/" element={<ConnectScreen />} />
		<Route path="/licenses" element={<LicensesScreen />} />
	</Routes>
);

export const AppRoutes: React.FC = () => {
	const { isAuthenticated, clearAuth } = useAuth();
	// the server ended the extension's sign-in while the popup is open (a
	// rejected renewal): the background signed out, and the popup follows
	useEffect(() => onSignedOut(() => void clearAuth()), [clearAuth]);
	return isAuthenticated ? <MainRoutes /> : <AuthRoutes />;
};
