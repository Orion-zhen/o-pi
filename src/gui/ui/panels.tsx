import { useState, type ReactNode, type Ref } from "react";
import type { GuiEvent, GuiSnapshot } from "../contract.ts";
import type { Send } from "./dialog.tsx";
import { Content, pretty, record } from "./content.tsx";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { NativeSelect } from "./components/ui/native-select";
import { PanelDialog } from "./components/panel-dialog";
import { ModelManager } from "./model-manager.tsx";
import { isSubagentDetails, SubagentProgress } from "./subagent-progress.tsx";
import { ReportPanel } from "./reports/report-panel.tsx";

export type PanelData = Extract<GuiEvent, { type: "panel" | "report" }>;
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(record) : []);

export function Panel({
	ref,
	panel,
	snapshot,
	sessionList,
	send,
	close,
	restoreFocus,
}: {
	ref: Ref<HTMLDivElement>;
	panel: PanelData;
	snapshot: GuiSnapshot;
	sessionList: ReactNode;
	send: Send;
	close: () => void;
	restoreFocus: () => void;
}) {
	let body;
	if (panel.type === "report") body = <ReportPanel report={panel} />;
	else switch (panel.title) {
		case "模型":
			body = <ModelManager snapshot={snapshot} send={send} />;
			break;
		case "工具选择":
			body = (
				<>
					<p>变更在当前会话分支生效。</p>
					<Button variant="outline" size="sm" onClick={() => void send({ action: "persistTools" })}>
						保存为用户默认
					</Button>
					{snapshot.tools.map((tool) => (
						<label key={tool.name} className="list-row">
							<Checkbox
								checked={tool.enabled}
								disabled={!tool.available || snapshot.busy || snapshot.streaming}
								onCheckedChange={(checked) => void send({ action: "tool", name: tool.name, enabled: checked === true })}
							/>
							<span>
								<strong>{tool.name}</strong>
								<small>{tool.description}</small>
							</span>
						</label>
					))}
				</>
			);
			break;
		case "会话列表":
			body = sessionList;
			break;
		case "设置":
			body = <Settings snapshot={snapshot} send={send} />;
			break;
		case "认证":
			body = (
				<>
					<p>凭据由 SDK 保存在后端，不返回到界面。OAuth 回调在运行后端的电脑上接收。</p>
					<Button variant="outline" size="sm" onClick={() => void send({ action: "cancelLogin" })}>
						取消登录
					</Button>
					{snapshot.providers.map((provider) => (
						<div className="list-row" key={provider.id}>
							<span>
								{provider.name}
								<small>{provider.authenticated ? "已配置" : "未配置"}</small>
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => void send({ action: "login", provider: provider.id, type: "api_key" })}
							>
								API Key
							</Button>
							{provider.oauth && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => void send({ action: "login", provider: provider.id, type: "oauth" })}
								>
									OAuth
								</Button>
							)}
							{provider.authenticated && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => void send({ action: "logout", provider: provider.id })}
								>
									退出
								</Button>
							)}
						</div>
					))}
				</>
			);
			break;
		case "子代理任务": {
			const result = record(panel.value) && record(panel.value.result) ? panel.value.result : panel.value;
			body = record(result) && isSubagentDetails(result.details) ? <>
				<SubagentProgress key={result.details.runId} details={result.details} state={snapshot.commandRunning ? "running" : "unavailable"} />
				{snapshot.commandRunning && <Button variant="outline" size="sm" onClick={() => void send({ action: "abort" })}>停止子代理任务</Button>}
			</> : <pre>{pretty(panel.value)}</pre>;
			break;
		}
		case "导入会话":
			body = (
				<label>
					选择 JSONL 文件
					<Input
						type="file"
						accept=".jsonl"
						onChange={(event) => {
							const file = event.target.files?.[0];
							if (file)
								void file
									.text()
									.then((content) => send({ action: "import", content }))
									.then((ok) => {
										if (ok) close();
									});
						}}
					/>
				</label>
			);
			break;
		case "系统提示词":
			body = <pre className="system-prompt">{String(panel.value)}</pre>;
			break;
		case "命令帮助":
			body = (
				<>
					{rows(panel.value).map((row) => (
						<p key={String(row.name)}>
							<code>/{String(row.name)}</code> {String(row.description)}
						</p>
					))}
				</>
			);
			break;
		default:
			body = typeof panel.value === "string" ? <Content value={panel.value} /> : <pre>{pretty(panel.value)}</pre>;
	}
	return (
		<PanelDialog ref={ref} title={panel.title} close={close} restoreFocus={restoreFocus}>
			{body}
		</PanelDialog>
	);
}

function Settings({ snapshot, send }: { snapshot: GuiSnapshot; send: Send }) {
	const settings = snapshot.settings;
	return (
		<>
			<div className="settings-grid">
				{(
					[
						["compaction", "自动压缩"],
						["retry", "自动重试"],
						["autoResize", "自动缩放图片"],
						["blockImages", "阻止图片发送"],
					] as const
				).map(([key, label]) => (
					<label key={key}>
						<Checkbox
							checked={settings[key]}
							onCheckedChange={(checked) => void send({ action: "settings", ...settings, [key]: checked === true })}
						/>
						{label}
					</label>
				))}
				{(
					[
						["steering", "Steer 队列"],
						["followUp", "Follow-up 队列"],
					] as const
				).map(([key, label]) => (
					<label key={key}>
						{label}
						<NativeSelect
							value={settings[key]}
							onChange={(event) =>
								void send({
									action: "settings",
									...settings,
									[key]: event.target.value === "all" ? "all" : "one-at-a-time",
								})
							}
						>
							<option value="one-at-a-time">逐条发送</option>
							<option value="all">一起发送</option>
						</NativeSelect>
					</label>
				))}
			</div>
			<Button variant="outline" size="sm" onClick={() => void send({ action: "config", file: "settings.json" })}>
				编辑完整 settings.json
			</Button>
		</>
	);
}

export function ConfigEditor({
	file,
	content,
	send,
	close,
	restoreFocus,
}: {
	file: "settings.json";
	content: string;
	send: Send;
	close: () => void;
	restoreFocus: () => void;
}) {
	const [text, setText] = useState(content || "{}\n");
	return (
		<PanelDialog title={file} close={close} restoreFocus={restoreFocus}>
			<p>保存后重载。文件在编辑期间发生变更时会拒绝覆盖。</p>
			<Textarea
				aria-label="设置 JSON"
				className="config-editor"
				value={text}
				onChange={(event) => setText(event.target.value)}
			/>
			<Button
				variant="outline"
				size="sm"
				onClick={() =>
					void send({ action: "saveConfig", file, original: content, content: text }).then((ok) => {
						if (ok) close();
					})
				}
			>
				保存并重载
			</Button>
		</PanelDialog>
	);
}
