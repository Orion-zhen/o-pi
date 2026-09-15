import { useState } from "react";
import type { GuiSnapshot } from "../contract.ts";
import type { Send } from "./dialog.tsx";
import { Content, pretty, record } from "./content.tsx";

export interface PanelData {
	title: string;
	value: unknown;
}
const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(record) : []);

export function ModelControls({ snapshot, send }: { snapshot: GuiSnapshot; send: Send }) {
	return (
		<div className="model-controls">
			<select
				aria-label="模型"
				value={snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : ""}
				disabled={snapshot.busy || snapshot.streaming}
				onChange={(event) => {
					const model = snapshot.models.find((model) => `${model.provider}/${model.id}` === event.target.value);
					if (model) void send({ action: "model", provider: model.provider, id: model.id });
				}}
			>
				<option value="">选择模型（先登录提供方）</option>
				{snapshot.models.map((model) => (
					<option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
						{model.provider} / {model.name}
					</option>
				))}
			</select>
			<select
				aria-label="思考级别"
				value={snapshot.thinking}
				disabled={snapshot.busy || snapshot.streaming}
				onChange={(event) => {
					const level = snapshot.thinkingLevels.find((level) => level === event.target.value);
					if (level) void send({ action: "thinking", level });
				}}
			>
				{snapshot.thinkingLevels.map((level) => (
					<option key={level}>{level}</option>
				))}
			</select>
		</div>
	);
}

export function Panel({
	panel,
	snapshot,
	send,
	close,
}: {
	panel: PanelData;
	snapshot: GuiSnapshot;
	send: Send;
	close: () => void;
}) {
	let body;
	switch (panel.title) {
		case "模型":
			body = <ModelControls snapshot={snapshot} send={send} />;
			break;
		case "工具选择":
			body = (
				<>
					<p>变更在当前会话分支生效。</p>
					<button onClick={() => void send({ action: "persistTools" })}>保存为用户默认</button>
					{snapshot.tools.map((tool) => (
						<label key={tool.name} className="list-row">
							<input
								type="checkbox"
								checked={tool.enabled}
								disabled={!tool.available || snapshot.busy || snapshot.streaming}
								onChange={(event) => void send({ action: "tool", name: tool.name, enabled: event.target.checked })}
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
		case "模型范围":
			body = (
				<>
					<p>不选择表示使用所有可用模型。</p>
					{snapshot.models.map((model) => {
						const id = `${model.provider}/${model.id}`;
						return (
							<label key={id} className="list-row">
								<input
									type="checkbox"
									checked={snapshot.scopedModels.includes(id)}
									onChange={(event) =>
										void send({
											action: "scopeModels",
											models: event.target.checked
												? [...snapshot.scopedModels, id]
												: snapshot.scopedModels.filter((value) => value !== id),
										})
									}
								/>
								{id}
							</label>
						);
					})}
				</>
			);
			break;
		case "会话列表":
			body = (
				<div>
					{rows(panel.value).map((row) => (
						<button
							className="session-item"
							key={String(row.path)}
							onClick={() => {
								if (typeof row.path === "string")
									void send({ action: "switch", path: row.path }).then((ok) => {
										if (ok) close();
									});
							}}
						>
							<strong>{String(row.name ?? row.firstMessage ?? row.id)}</strong>
							<small>
								{String(row.cwd)} · {String(row.modified)}
							</small>
						</button>
					))}
				</div>
			);
			break;
		case "会话树":
			body = <Tree value={panel.value} send={send} />;
			break;
		case "设置":
			body = <Settings snapshot={snapshot} send={send} />;
			break;
		case "认证":
			body = (
				<>
					<p>凭据由 SDK 保存在后端，不返回到界面。OAuth 回调在运行后端的电脑上接收。</p>
					<button onClick={() => void send({ action: "cancelLogin" })}>取消登录</button>
					{snapshot.providers.map((provider) => (
						<div className="list-row" key={provider.id}>
							<span>
								{provider.name}
								<small>{provider.authenticated ? "已配置" : "未配置"}</small>
							</span>
							<button onClick={() => void send({ action: "login", provider: provider.id, type: "api_key" })}>
								API Key
							</button>
							{provider.oauth && (
								<button onClick={() => void send({ action: "login", provider: provider.id, type: "oauth" })}>
									OAuth
								</button>
							)}
							{provider.authenticated && (
								<button onClick={() => void send({ action: "logout", provider: provider.id })}>退出</button>
							)}
						</div>
					))}
				</>
			);
			break;
		case "导入会话":
			body = (
				<label>
					选择 JSONL 文件
					<input
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
		<div className="panel-backdrop">
			<aside role="dialog" aria-label={panel.title} className="panel">
				<header>
					<h2>{panel.title}</h2>
					<button onClick={close} aria-label="关闭面板">
						关闭
					</button>
				</header>
				{body}
			</aside>
		</div>
	);
}

function Tree({ value, send }: { value: unknown; send: Send }) {
	return (
		<ul className="tree">
			{rows(value).map((node) => {
				if (!record(node.entry)) return null;
				const entry = node.entry;
				const id = String(entry.id);
				return (
					<li key={id}>
						<details open>
							<summary>
								{String(node.label ?? entry.type)} · {id}
							</summary>
							<pre>{pretty(entry).slice(0, 3000)}</pre>
							<div className="toolbar">
								<button onClick={() => void send({ action: "navigate", entryId: id, summarize: false })}>
									切换到此处
								</button>
								<button onClick={() => void send({ action: "navigate", entryId: id, summarize: true })}>
									总结后切换
								</button>
								<button onClick={() => void send({ action: "fork", entryId: id })}>创建分支</button>
							</div>
							<form
								onSubmit={(event) => {
									event.preventDefault();
									const label = new FormData(event.currentTarget).get("label");
									if (typeof label === "string") void send({ action: "label", entryId: id, label });
								}}
							>
								<input name="label" aria-label="分支标签" defaultValue={String(node.label ?? "")} />
								<button>保存标签</button>
							</form>
						</details>
						<Tree value={node.children} send={send} />
					</li>
				);
			})}
		</ul>
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
						<input
							type="checkbox"
							checked={settings[key]}
							onChange={(event) => void send({ action: "settings", ...settings, [key]: event.target.checked })}
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
						<select
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
						</select>
					</label>
				))}
			</div>
			<button onClick={() => void send({ action: "config", file: "settings.json" })}>编辑完整 settings.json</button>
		</>
	);
}

export function ConfigEditor({
	file,
	content,
	send,
	close,
}: {
	file: "settings.json";
	content: string;
	send: Send;
	close: () => void;
}) {
	const [text, setText] = useState(content || "{}\n");
	return (
		<div className="panel-backdrop">
			<aside className="panel">
				<header>
					<h2>{file}</h2>
					<button onClick={close}>关闭</button>
				</header>
				<p>保存后重载。文件在编辑期间发生变更时会拒绝覆盖。</p>
				<textarea
					aria-label="设置 JSON"
					className="config-editor"
					value={text}
					onChange={(event) => setText(event.target.value)}
				/>
				<button
					onClick={() =>
						void send({ action: "saveConfig", file, original: content, content: text }).then((ok) => {
							if (ok) close();
						})
					}
				>
					保存并重载
				</button>
			</aside>
		</div>
	);
}
