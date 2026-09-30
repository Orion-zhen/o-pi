import { useCallback, useEffect, useRef, useState } from "react";
import type { GuiAction, GuiEvent } from "../contract.ts";
import { OAuthBrowser } from "./oauth-browser.ts";
import type { Send } from "./connection.ts";

export function useGuiActions(dispatch: (action: GuiAction) => Promise<void>, reportError: (message: string) => void, closePanel: () => void) {
	const [auth, setAuth] = useState<Extract<GuiEvent, { type: "auth" }>["value"]>();
	const [authUrl, setAuthUrl] = useState<string>();
	const [deviceCode, setDeviceCode] = useState<string>();
	const [browser] = useState(() => new OAuthBrowser());
	const pending = useRef(false);
	const finish = useCallback(() => { browser.finish(); setAuth(undefined); setAuthUrl(undefined); setDeviceCode(undefined); }, [browser]);
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
		if (url) { setAuthUrl(url); void browser.open(url).catch((error: unknown) => reportError(String(error))); }
	};
	const send: Send = useCallback(async (action) => {
		const mcpLogin = action.action === "prompt" && /^\/mcp\s+login(?:\s|$)/.test(action.text);
		const login = action.action === "login" || mcpLogin;
		if (login) {
			if (pending.current) return false;
			pending.current = true;
		}
		try {
			if (mcpLogin || action.action === "login" && action.type === "oauth") {
				closePanel(); setAuthUrl(undefined); setDeviceCode(undefined); browser.prepare();
			}
			if (action.action === "dialog" && action.value !== null) browser.resume();
			await dispatch(action);
			return true;
		} catch (error) {
			if (login) finish();
			reportError(error instanceof Error ? error.message : String(error));
			return false;
		} finally { if (login) { pending.current = false; finish(); } }
	}, [dispatch, browser, finish, closePanel, reportError]);
	return { auth, authUrl, deviceCode, receive, send, finish };
}
