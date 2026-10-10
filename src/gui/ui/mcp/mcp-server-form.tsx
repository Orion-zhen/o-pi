import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Reveal } from "../components/animated.tsx";
import { Plus, Trash2 } from "lucide-react";
import { mcpObject, type McpIssue } from "../../mcp-validation.ts";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { IconButton } from "../components/icon-button.tsx";
import { SettingsDisclosure } from "../settings/settings-controls.tsx";
import { changeMcpTransport, mcpId, type McpMapField, type McpPair, type McpServerDraft } from "./mcp-draft.ts";
import { McpChoice, McpField, McpPairs, McpTextField, mcpText } from "./mcp-fields.tsx";
import { exposureOptions } from "./mcp-exposure.tsx";
import { McpAuthFields } from "./mcp-auth-fields.tsx";
import { parseMcpCommand } from "./mcp-command.ts";

export function McpServerForm({ server, issues, disabled, change }: {
	server: McpServerDraft; issues: McpIssue[]; disabled: boolean; change: (server: McpServerDraft) => void;
}) {
	const [paste, setPaste] = useState(false);
	const [commandText, setCommandText] = useState("");
	const [commandError, setCommandError] = useState("");
	const [transport, setTransport] = useState<boolean>();
	if (!mcpObject(server.config)) return <p role="alert">服务配置不是对象，请使用 JSON 修复，或删除后重新添加。</p>;
	const config = server.config;
	const editable = { ...server, config };
	const remote = config.type === "http" || config.type === "streamable-http" || (config.type === undefined && "url" in config);
	const field = (key: string, value: unknown) => {
		const next = { ...config };
		if (value === undefined) delete next[key]; else next[key] = value;
		change({ ...server, config: next });
	};
	const pairs = (key: McpMapField, rows: McpPair[]) => change({ ...server, maps: { ...server.maps, [key]: rows } });
	const args = server.args ?? [];
	const createArgument = (value: unknown) => ({ id: mcpId(), value });
	const selectTransport = (value: string) => {
		const nextRemote = value === "http";
		if (nextRemote === remote) return;
		const configured = remote ? config.url || config.auth || config.oauth || server.maps.headers?.length
			: config.command || args.length || config.cwd || server.maps.env?.length;
		if (configured) setTransport(nextRemote); else change(changeMcpTransport(editable, nextRemote));
	};
	return <fieldset className="mcp-server-form" disabled={disabled}>
		<div className="mcp-form-grid">
			<McpTextField label="服务名称" field="name" issues={issues} value={server.name} onChange={(name) => change({ ...server, name })} />
			<McpField label="连接方式" field="type" issues={issues}>
				<McpChoice disabled={disabled} label="连接方式" value={remote ? "http" : "stdio"} options={[["stdio", "本地进程"], ["http", "远程 HTTP"]]} change={selectTransport} />
			</McpField>
		</div>
		{transport !== undefined && <div className="mcp-confirm"><p>切换连接方式会清除当前的连接与认证字段，通用设置保留。</p>
			<Button size="sm" variant="outline" onClick={() => { change(changeMcpTransport(editable, transport)); setTransport(undefined); }}>确认切换</Button>
			<Button size="sm" variant="ghost" onClick={() => setTransport(undefined)}>取消</Button>
		</div>}
		{remote ? <>
			<McpTextField label="服务地址" field="url" issues={issues} value={config.url} placeholder="https://example.com/mcp" onChange={(value) => field("url", value)} />
			<McpAuthFields server={server} config={config} issues={issues} change={change} disabled={disabled} />
		</> : <>
			<div className="mcp-field-heading"><span className="settings-description">在运行 opi 的机器启动，不是浏览器所在设备。</span>
				<Button variant="ghost" size="sm" onClick={() => setPaste(!paste)}>粘贴启动命令</Button>
			</div>
			{paste && <div className="mcp-command-paste"><Input aria-label="完整启动命令" placeholder={'npx -y server-package "带空格的路径"'} value={commandText} onChange={(event) => { setCommandText(event.target.value); setCommandError(""); }} />
				<Button size="sm" variant="outline" onClick={() => {
					let command: ReturnType<typeof parseMcpCommand>;
					try { command = parseMcpCommand(commandText); }
					catch (error) { setCommandError(error instanceof Error ? error.message : String(error)); return; }
					change({ ...server, config: { ...config, command: command.command }, args: command.args.map(createArgument) });
					setPaste(false); setCommandText("");
				}}>拆分到表单</Button>
				<p className="settings-description">支持 POSIX 引号与转义。只拆分、不执行，将替换下面的程序和参数。Windows 路径请直接填写参数列表。</p>
				{commandError && <p role="alert">{commandError}</p>}
			</div>}
			<McpTextField label="启动程序" field="command" issues={issues} value={config.command} placeholder="npx、uvx 或可执行文件路径" onChange={(value) => field("command", value)} />
			<McpField label="启动参数" field="args" issues={issues} hint="每项是一个完整参数，路径含空格时无需添加引号。">
				<div className="mcp-args"><AnimatePresence initial={false}>{args.map((arg, index) => <Reveal key={arg.id}><div className="mcp-arg">
					<Input aria-label={`启动参数 ${index + 1}`} value={mcpText(arg.value)} onChange={(event) => change({ ...server, args: args.map((row) => row.id === arg.id ? { ...row, value: event.target.value } : row) })} />
					<IconButton size="icon-sm" label={`删除启动参数 ${index + 1}`} tooltip="删除参数" onClick={() => change({ ...server, args: args.filter(({ id }) => id !== arg.id) })}><Trash2 /></IconButton>
				</div></Reveal>)}</AnimatePresence><Button variant="outline" size="sm" className="mcp-add-row" onClick={() => change({ ...server, args: [...args, createArgument("")] })}><Plus />添加参数</Button></div>
			</McpField>
			<McpField label="环境变量" field="env" issues={issues} hint="支持 ${ENV_NAME} 和整个值为 !command 的命令取值。环境变量来自运行 opi 的进程。">
				<McpPairs disabled={disabled} label="环境变量" rows={server.maps.env ?? []} change={(rows) => pairs("env", rows)} />
			</McpField>
		</>}
		<SettingsDisclosure title="工具与高级设置">
			<div className="mcp-advanced">
				{!remote && <McpTextField label="工作目录" field="cwd" issues={issues} value={config.cwd} hint="留空使用会话目录，相对路径也以会话目录为基准。" onChange={(value) => field("cwd", value || undefined)} />}
				<McpTextField label="能力描述" field="description" issues={issues} value={config.description} hint="向模型说明这个服务提供什么能力，不只是界面备注。" onChange={(value) => field("description", value || undefined)} />
				<McpTextField label="请求超时（秒）" field="timeout" issues={issues} value={config.timeout} placeholder="60（默认）" numeric onChange={(value) => field("timeout", value === "" ? undefined : Number(value) || value)} />
				<McpField label="工具使用方式" field="exposure" issues={issues} hint="默认不直接声明工具，可通过脚本或搜索发现。始终提供会增加上下文占用。隐藏不会停止服务连接。">
					<McpChoice disabled={disabled} label="工具使用方式" value={config.exposure === "codemode-deferred" ? "codemode" : mcpText(config.exposure ?? "codemode")} options={exposureOptions} change={(value) => field("exposure", value === "codemode" ? undefined : value)} />
				</McpField>
				<McpField label="单工具规则" field="toolExposure" issues={issues} hint="填写服务原始工具名或 * 通配模式。精确名称优先，通配规则从上到下匹配。">
					<McpPairs disabled={disabled} label="工具规则" kind="exposure" rows={server.maps.toolExposure ?? []} change={(rows) => pairs("toolExposure", rows)} />
				</McpField>
			</div>
		</SettingsDisclosure>
		{issues.length > 0 && <div className="mcp-issues" role="alert">请修正：{[...new Set(issues.map((issue) => `${issue.field || "配置"}：${issue.message}`))].join(" ")}</div>}
	</fieldset>;
}
