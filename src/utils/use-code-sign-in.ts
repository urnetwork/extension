// The popup's code entry (popup/components/AuthInitial.tsx): signs in with a
// code through the background (utils/code-sign-in.ts) and keeps how it went.
import { useCallback, useState } from "react";
import { useAuth } from "@urnetwork/sdk/react";
import { codeSignInFailure, requestCodeSignIn, type CodeSignInFailure } from "./code-sign-in";

export function useCodeSignIn() {
	const { setAuth } = useAuth();
	const [loading, setLoading] = useState(false);
	const [failure, setFailure] = useState<CodeSignInFailure | null>(null);

	const signIn = useCallback(
		async (authCode: string) => {
			setLoading(true);
			setFailure(null);
			const answer = await requestCodeSignIn(authCode);
			if (answer.success) {
				// the background stored the sign-in; the popup's state follows it
				await setAuth(answer.jwt, answer.networkName);
			} else {
				setFailure(codeSignInFailure(answer.code));
			}
			setLoading(false);
		},
		[setAuth],
	);

	return { signIn, loading, failure, setFailure };
}
