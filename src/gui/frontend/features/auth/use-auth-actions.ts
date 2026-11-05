import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiAction } from "../../../shared/protocol/actions.ts";
import type { GuiEvent } from "../../../shared/protocol/events.ts";
import { OAuthBrowser } from "./oauth-browser.ts";

type LoginAction = Extract<GuiAction, { action: "login" | "prompt" }>;
export function isLoginAction(action: GuiAction): action is LoginAction {
	return action.action === "login" || action.action === "prompt" && /^\/mcp\s+login(?:\s|$)/.test(action.text);
}

export function useAuthActions(dispatch: (action: LoginAction) => Promise<void>, closePanel: () => void) {
	const [auth, setAuth] = useState<Extract<GuiEvent, { type: "auth" }>["value"]>();
	const [authUrl, setAuthUrl] = useState<string>();
	const [deviceCode, setDeviceCode] = useState<string>();
	const [error, setError] = useState("");
	const [browser] = useState(() => new OAuthBrowser());
	const pending = useRef<Promise<void> | undefined>(undefined);
	const finish = useCallback(() => { browser.finish(); setAuth(undefined); setAuthUrl(undefined); setDeviceCode(undefined); setError(""); }, [browser]);
	useEffect(() => () => browser.finish(), [browser]);
	const receive = (event: GuiEvent) => {
		if (event.type === "dialogs" && event.value.length) browser.waitForInput();
		if (event.type === "snapshot" && !event.value) setAuth(undefined);
		if (event.type !== "auth") return;
		if (!event.value) { finish(); return; }
		setAuth(event.value);
		const url = event.value.type === "auth_url" ? event.value.url
			: event.value.type === "device_code" ? event.value.verificationUri : undefined;
		if (event.value.type === "device_code") setDeviceCode(event.value.userCode);
		if (url) { setAuthUrl(url); void browser.open(url).catch((error: unknown) => setError(String(error))); }
	};
	const login = useCallback((action: LoginAction): Promise<void> => {
		if (pending.current) return pending.current;
		const run = async () => {
			if (action.action === "prompt" || action.type === "oauth") {
				closePanel(); setAuthUrl(undefined); setDeviceCode(undefined); browser.prepare();
			}
			await dispatch(action);
		};
		pending.current = run().finally(() => { pending.current = undefined; finish(); });
		return pending.current;
	}, [dispatch, browser, finish, closePanel]);
	const resume = useCallback(() => browser.resume(), [browser]);
	return { auth, authUrl, deviceCode, receive, login, resume, finish, error, setError };
}
