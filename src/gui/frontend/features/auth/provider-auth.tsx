import { useContext, useState } from "react";
import { NotificationErrorContext } from "@/ui/notifications.tsx";
import { Feedback } from "@/ui/feedback.tsx";
import type { GuiAction } from "../../../shared/protocol/actions.ts";
import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { AnimatePresence } from "motion/react";
import { Crossfade, Fade } from "@/ui/motion/animated.tsx";

export function ProviderAuth({ providers, send, disabled }: { providers: GuiSnapshot["providers"]; send: Send; disabled: boolean }) {
	const notifyError = useContext(NotificationErrorContext);
	const [error, setError] = useState("");
	const run = async (action: Extract<GuiAction, { action: "login" | "logout" }>) => {
		setError("");
		try { await send(action); }
		catch (error) {
			if (action.action === "login" && action.type === "oauth") notifyError(error);
			else setError(error instanceof Error ? error.message : String(error));
		}
	};
	return <>
		<p>OAuth 在浏览器中完成，凭据保存在后端。</p>
		{providers.map((provider) => <div className="list-row" data-authenticated={provider.authenticated} key={provider.id}>
			<span>{provider.name}<small><Crossfade value={String(provider.authenticated)}>{provider.authenticated ? "已配置" : "未配置"}</Crossfade></small></span>
			{provider.apiKey && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run({ action: "login", provider: provider.id, type: "api_key" })}>API Key</Button>}
			{provider.oauth && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run({ action: "login", provider: provider.id, type: "oauth" })}>OAuth</Button>}
			<AnimatePresence>{provider.authenticated && <Fade><Button variant="outline" size="sm" className="bg-secondary text-foreground" onClick={() => void run({ action: "logout", provider: provider.id })}>退出</Button></Fade>}</AnimatePresence>
		</div>)}
		<Feedback compact message={error} tone="error" />
	</>;
}
