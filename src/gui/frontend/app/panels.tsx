import type { ReactNode, Ref } from "react";
import { LoaderCircle } from "lucide-react";
import type { ViewPanel } from "./use-panels.ts";
import type { GuiAction, GuiActionResult } from "../../shared/protocol/actions.ts";
import type { GuiPanel, GuiSnapshot } from "../../shared/protocol/state.ts";
import type { Send } from "@/connection/connection.ts";
import { Content } from "@/features/chat/messages/content.tsx";
import { Button } from "@/ui/button.tsx";
import { ToolSelection } from "@/features/chat/tools/tool-selection.tsx";
import { Input } from "@/ui/input.tsx";
import { PanelDialog } from "@/ui/panel-dialog.tsx";
import { ModelManager } from "@/features/models/model-manager.tsx";
import { SubagentProgress } from "@/features/chat/tools/subagent-progress.tsx";
import { UsageReport } from "@/features/reports/usage-report.tsx";
import { ProviderAuth } from "@/features/auth/provider-auth.tsx";
import "@/features/reports/reports.css";

const titles: Record<GuiPanel["kind"], string> = {
	model: "模型", tools: "工具选择", sessions: "会话列表", settings: "设置", auth: "认证",
	subagents: "子代理任务", import: "导入会话", system: "系统提示词", help: "命令帮助",
	lastReply: "最后回复", usage: "用量情况",
};

export function Panel({ ref, panel, snapshot, sessionList, send, dispatch, canSubmit, close, restoreFocus }: {
	ref: Ref<HTMLDivElement>;
	panel: Exclude<ViewPanel, { kind: "settings" }>;
	snapshot: GuiSnapshot;
	sessionList: ReactNode;
	send: Send;
	dispatch<A extends GuiAction>(action: A): Promise<GuiActionResult<A>>;
	canSubmit: boolean;
	close: () => void;
	restoreFocus: () => void;
}) {
	let body: ReactNode;
	switch (panel.kind) {
		case "model": body = <ModelManager snapshot={snapshot} send={send} disabled={!canSubmit} />; break;
		case "tools":
			body = <ToolSelection snapshot={snapshot} send={send} disabled={!canSubmit} />;
			break;
		case "sessions": body = sessionList; break;
		case "auth": body = <ProviderAuth providers={snapshot.providers} send={send} disabled={!canSubmit} />; break;
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
		case "usage":
			body = panel.value === "loading" ? <div className="report-inline report-empty" role="status">
				<LoaderCircle className="animate-spin shrink-0 size-[1em]" aria-hidden="true" /><span>正在查询用量…</span>
			</div> : <UsageReport value={panel.value} disabled={!canSubmit}
				onUse={(creditId, requestId) => dispatch({ action: "consumeCodexCredit", creditId, requestId })}
				onRefresh={() => dispatch({ action: "view", view: "usage", refresh: true })} />;
			break;
	}
	return <PanelDialog ref={ref} title={titles[panel.kind]} close={close} restoreFocus={restoreFocus}>{body}</PanelDialog>;
}
