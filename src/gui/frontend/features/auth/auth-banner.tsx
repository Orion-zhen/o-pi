import { ExternalLink, ShieldCheck } from "lucide-react";
import type { GuiEvent } from "../../../shared/protocol/events.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { safeLink } from "@/ui/content/format.ts";
import { Feedback } from "@/ui/feedback.tsx";
import { AnimatePresence } from "motion/react";
import { Reveal } from "@/ui/motion/animated.tsx";

export function AuthBanner({ auth, url, deviceCode, send, error, onError }: {
	auth: NonNullable<Extract<GuiEvent, { type: "auth" }>["value"]>;
	url: string | undefined;
	deviceCode: string | undefined;
	send: Send;
	error: string;
	onError: (message: string) => void;
}) {
	return <div className="auth-banner">
		<div className="flex items-center justify-between">
			<span className="flex items-center gap-2"><ShieldCheck className="size-4" />模型认证</span>
		</div>
		<Feedback message={url ? "在浏览器中完成登录" : ""} />
		<AnimatePresence>{deviceCode && <Reveal><p>设备码：<strong>{deviceCode}</strong></p></Reveal>}</AnimatePresence>
		<Feedback compact message={auth.type === "progress" || auth.type === "info" ? auth.message : ""} />
		<Feedback compact message={error} tone="error" />
		{auth.type === "info" && auth.links?.filter((link) => safeLink(link.url)).map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label ?? link.url}</a>)}
		<Feedback message={url && !window.opi ? "远程访问建议使用设备码登录" : ""} />
		<div className="toolbar">
			{url && safeLink(url) && <Button variant="outline" size="sm" asChild>
				<a href={url} target="_blank" rel="noreferrer" onClick={(event) => {
					if (window.opi) {
						event.preventDefault();
						void window.opi.openExternal(url).catch((error: unknown) => onError(String(error)));
					}
				}}><ExternalLink />打开认证页面</a>
			</Button>}
			<Button variant="ghost" size="sm" onClick={() => void send({ action: "cancelLogin" }).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))}>取消登录</Button>
		</div>
	</div>;
}
