import { ExternalLink, ShieldCheck } from "lucide-react";
import type { GuiEvent } from "../../../shared/protocol/events.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";
import { safeLink } from "@/ui/content/format.ts";

export function AuthBanner({ auth, url, deviceCode, send, onError }: {
	auth: NonNullable<Extract<GuiEvent, { type: "auth" }>["value"]>;
	url: string | undefined;
	deviceCode: string | undefined;
	send: Send;
	onError: (message: string) => void;
}) {
	return <div className="auth-banner">
		<div className="flex items-center justify-between">
			<span className="flex items-center gap-2"><ShieldCheck className="size-4" />模型认证</span>
		</div>
		{url && <p>请在认证页面完成登录，完成后会自动继续。未打开页面？点击下方按钮。</p>}
		{deviceCode && <p>在认证页面输入设备码：<strong>{deviceCode}</strong></p>}
		{(auth.type === "progress" || auth.type === "info") && <p role="status">{auth.message}</p>}
		{auth.type === "info" && auth.links?.filter((link) => safeLink(link.url)).map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label ?? link.url}</a>)}
		{url && !window.opi && <p className="text-sm text-muted-foreground">远程连接时，本地回调可能无法到达后端；请使用提供方支持的设备码登录。</p>}
		<div className="toolbar">
			{url && safeLink(url) && <Button variant="outline" size="sm" asChild>
				<a href={url} target="_blank" rel="noreferrer" onClick={(event) => {
					if (window.opi) {
						event.preventDefault();
						void window.opi.openExternal(url).catch((error: unknown) => onError(String(error)));
					}
				}}><ExternalLink />打开认证页面</a>
			</Button>}
			<Button variant="ghost" size="sm" onClick={() => void send({ action: "cancelLogin" })}>取消登录</Button>
		</div>
	</div>;
}
