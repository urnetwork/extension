import { createContext } from "react";

interface AuthContextType {
	token: string | null;
	userAuth: string;
	setUserAuth: (userAuth: string) => void;
}

export const AuthContext = createContext<AuthContextType>({
	token: null,
	userAuth: "",
	setUserAuth: () => {},
});
