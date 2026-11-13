import { useCallback, useEffect } from "react";
import type { GuiConnection } from "../../shared/protocol/connection.ts";
import type { GuiAction, GuiActionResult } from "../../shared/protocol/actions.ts";
import type { Query } from "../../shared/protocol/queries.ts";
import { isLoginAction, useAuthActions } from "@/features/auth/use-auth-actions.ts";

/** 会话操作在构造时绑定目标，认证只包装需要浏览器交互的操作。 */
export function useSessionCommands(connection: Pick<GuiConnection, "send" | "query"> & { connected: boolean }, sessionId: string | null, closePanel: () => void) {
	const { send: sendAction, query: readQuery, connected } = connection;
	const dispatch = useCallback(<A extends GuiAction>(action: A) => sendAction(action, sessionId), [sendAction, sessionId]);
	const auth = useAuthActions(dispatch, closePanel);
	useEffect(() => { if (!connected) auth.finish(); }, [connected, auth.finish]);
	function send<A extends GuiAction>(action: A): Promise<GuiActionResult<A>>;
	function send(action: GuiAction): Promise<GuiActionResult> {
		if (isLoginAction(action)) return auth.login(action);
		if (action.action === "dialog" && action.value !== null) auth.resume();
		return dispatch(action);
	}
	const sendCommand = useCallback(send, [dispatch, auth.login, auth.resume]);
	const query = useCallback<Query>((request) => readQuery(request, sessionId), [readQuery, sessionId]);
	return { send: sendCommand, query, auth };
}
