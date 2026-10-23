import type { GuiSnapshot } from "../../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Button } from "@/ui/button.tsx";

export function ProviderAuth({ providers, send, disabled }: { providers: GuiSnapshot["providers"]; send: Send; disabled: boolean }) {
	return <>
		<p>OAuth 会打开浏览器，完成认证后自动继续。凭据保存在后端，不返回到界面。</p>
		{providers.map((provider) => <div className="list-row" data-authenticated={provider.authenticated} key={provider.id}>
			<span>{provider.name}<small>{provider.authenticated ? "已配置" : "未配置"}</small></span>
			{provider.apiKey && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void send({ action: "login", provider: provider.id, type: "api_key" })}>API Key</Button>}
			{provider.oauth && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void send({ action: "login", provider: provider.id, type: "oauth" })}>OAuth</Button>}
			{provider.authenticated && <Button variant="outline" size="sm" className="bg-secondary text-foreground" onClick={() => void send({ action: "logout", provider: provider.id })}>退出</Button>}
		</div>)}
	</>;
}
