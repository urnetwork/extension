import { type FC, type PropsWithChildren, useState, useEffect } from "react";
import { AuthContext } from "./AuthContext";

export const AuthContextProvider: FC<PropsWithChildren> = ({ children }) => {
	const [userAuth, setUserAuthState] = useState("");

	// Load userAuth from Chrome storage on mount
	useEffect(() => {
		chrome.storage.local.get(["userAuth"], (result: { userAuth?: string }) => {
			setUserAuthState(result.userAuth || "");
		});
	}, []);

	// Save userAuth to Chrome storage whenever it changes
	const setUserAuth = (newUserAuth: string) => {
		setUserAuthState(newUserAuth);
		chrome.storage.local.set({ userAuth: newUserAuth });
	};

	return (
		<AuthContext.Provider value={{ token: null, userAuth, setUserAuth }}>
			{children}
		</AuthContext.Provider>
	);
};
