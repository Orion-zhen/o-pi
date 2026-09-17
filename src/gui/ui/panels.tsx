import type { ReactNode, Ref } from "react";
import type { GuiPanel, GuiSnapshot } from "../contract.ts";
import type { Send } from "./connection.ts";
import { Content } from "./content.tsx";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { PanelDialog } from "./components/panel-dialog";
import { ModelManager } from "./model-manager.tsx";
import { SubagentProgress } from "./subagent-progress.tsx";
import { UsageReport } from "./reports/usage-report.tsx";
import "./reports/reports.css";

const titles: Record<GuiPanel["kind"], string> = {
	model: "模型", tools: "工具选择", sessions: "会话列表", settings: "设置", auth: "认证",
	subagents: "子代理任务", import: "导入会话", system: "系统提示词", help: "命令帮助",
	lastReply: "最后回复", usage: "套餐用量",
};

export function Panel({ ref, panel, snapshot, sessionList, send, canChangeSession, close, restoreFocus }: {
	ref: Ref<HTMLDivElement>;
	panel: Exclude<GuiPanel, { kind: "settings" }>;
	snapshot: GuiSnapshot;
	sessionList: ReactNode;
	send: Send;
	canChangeSession: boolean;
	close: () => void;
	restoreFocus: () => void;
}) {
	let body: ReactNode;
	switch (panel.kind) {
		case "model": body = <ModelManager snapshot={snapshot} send={send} disabled={!canChangeSession} />; break;
		case "tools":
			body = <>
				<p>变更在当前会话分支生效。</p>
				<Button variant="outline" size="sm" disabled={!canChangeSession} onClick={() => void send({ action: "persistTools" })}>保存为用户默认</Button>
				{snapshot.tools.map((tool) => <label key={tool.name} className="list-row">
					<Checkbox checked={tool.enabled} disabled={!tool.available || !canChangeSession}
						onCheckedChange={(checked) => void send({ action: "tool", name: tool.name, enabled: checked === true })} />
					<span><strong>{tool.name}</strong><small>{tool.description}</small></span>
				</label>)}
			</>;
			break;
		case "sessions": body = sessionList; break;
		case "auth":
			body = <>
				<p>凭据由 SDK 保存在后端，不返回到界面。OAuth 回调在运行后端的电脑上接收。</p>
				<Button variant="outline" size="sm" onClick={() => void send({ action: "cancelLogin" })}>取消登录</Button>
				{snapshot.providers.map((provider) => <div className="list-row" data-authenticated={provider.authenticated} key={provider.id}>
					<span>{provider.name}<small>{provider.authenticated ? "已配置" : "未配置"}</small></span>
					<Button variant="outline" size="sm" onClick={() => void send({ action: "login", provider: provider.id, type: "api_key" })}>API Key</Button>
					{provider.oauth && <Button variant="outline" size="sm" onClick={() => void send({ action: "login", provider: provider.id, type: "oauth" })}>OAuth</Button>}
					{provider.authenticated && <Button variant="outline" size="sm" onClick={() => void send({ action: "logout", provider: provider.id })}>退出</Button>}
				</div>)}
			</>;
			break;
		case "subagents":
			body = <>
				<SubagentProgress key={panel.details.runId} details={panel.details} state={snapshot.commandRunning ? "running" : "unavailable"} />
				{snapshot.commandRunning && <Button variant="outline" size="sm" onClick={() => void send({ action: "abort" })}>停止子代理任务</Button>}
			</>;
			break;
		case "import":
			body = <label>选择 JSONL 文件<Input type="file" accept=".jsonl" onChange={(event) => {
				const file = event.target.files?.[0];
				if (file) void file.text().then((content) => send({ action: "import", content })).then((ok) => { if (ok) close(); });
			}} /></label>;
			break;
		case "system": body = <pre className="system-prompt">{panel.text}</pre>; break;
		case "help": body = snapshot.commands.map((command) => <p key={command.name}><code>/{command.name}</code> {command.description}</p>); break;
		case "lastReply": body = <Content value={panel.text} />; break;
		case "usage": body = <UsageReport value={panel.value} />; break;
	}
	return <PanelDialog ref={ref} title={titles[panel.kind]} close={close} restoreFocus={restoreFocus}>{body}</PanelDialog>;
}
