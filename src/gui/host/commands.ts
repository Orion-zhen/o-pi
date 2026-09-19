import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { GuiAction, GuiPanel, GuiQueryResults } from "../contract.ts";
import type { GuiSession } from "./session.ts";

export const builtinCommands = ([
	["new", "新建会话"],
	["resume", "恢复会话"],
	["tree", "会话树与分支"],
	["fork", "从消息创建分支"],
	["name", "重命名会话"],
	["model", "管理模型"],
	["scoped-models", "管理模型"],
	["thinking", "思考级别"],
	["settings", "设置"],
	["login", "登录提供方"],
	["logout", "退出提供方"],
	["compact", "压缩上下文"],
	["export", "导出 HTML 或 JSONL"],
	["import", "导入 JSONL"],
	["reload", "重载资源"],
	["copy", "复制最后回复"],
	["help", "命令帮助"],
	["quit", "关闭界面"],
] as const).map(([name, description]) => ({ name, description }));

export async function completeCommand(session: AgentSession, text: string): Promise<GuiQueryResults["complete"]> {
	const match = /^\/(\S+)(?:\s(.*))?$/s.exec(text);
	const name = match?.[1];
	if (!name) return [];
	const prefix = match[2] ?? "";
	const command = session.extensionRunner.getCommand(name);
	if (command) return await command.getArgumentCompletions?.(prefix) ?? [];
	let items: GuiQueryResults["complete"];
	switch (name) {
		case "thinking":
			items = session.getAvailableThinkingLevels().map((level) => ({ value: level, label: level }));
			break;
		case "export":
			items = [
				{ value: "html", label: "html", description: "导出为网页" },
				{ value: "jsonl", label: "jsonl", description: "导出为会话数据" },
			];
			break;
		default: return [];
	}
	return items.filter((item) => item.value.startsWith(prefix.trimStart()));
}

/** 界面命令复用内部操作，扩展命令和模板继续交给 SDK prompt。 */
export async function runBuiltin(host: GuiSession, text: string, execute: (action: GuiAction) => Promise<void>): Promise<boolean> {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return false;
	const name = match[1];
	const args = match[2]?.trim() ?? "";
	const session = host.runtime.session;
	if (!name || session.extensionRunner.getCommand(name)) return false;
	const panel = (panel: GuiPanel) => host.emit({ type: "panel", panel });
	switch (name) {
		case "new":
			await execute({ action: "new" });
			break;
		case "resume":
			await execute(args ? { action: "switch", path: path.resolve(host.runtime.cwd, args) } : { action: "sessions" });
			if (!args) panel({ kind: "sessions" });
			break;
		case "tree":
		case "fork":
			if (args) await execute({ action: "fork", entryId: args });
			else host.emit({ type: "sessionTab", tab: "tree" });
			break;
		case "name": {
			const value = args || (await host.dialogs.ask("input", "会话名称", "", [], session.sessionName ?? ""));
			if (value) await execute({ action: "rename", name: value });
			break;
		}
		case "model":
		case "scoped-models":
			panel({ kind: "model" });
			break;
		case "thinking":
			if (args) {
				const level = session.getAvailableThinkingLevels().find((level) => level === args);
				if (!level) throw new Error("无效思考级别。");
				await execute({ action: "thinking", level });
			} else panel({ kind: "model" });
			break;
		case "settings": panel({ kind: "settings" }); break;
		case "login":
		case "logout": panel({ kind: "auth" }); break;
		case "compact": await execute({ action: "compact", instructions: args }); break;
		case "export": await execute({ action: "export", format: args === "jsonl" ? "jsonl" : "html" }); break;
		case "import":
			if (args) await execute({ action: "import", content: await readFile(path.resolve(host.runtime.cwd, args), "utf8") });
			else panel({ kind: "import" });
			break;
		case "reload": await execute({ action: "reload" }); break;
		case "copy": panel({ kind: "lastReply", text: session.getLastAssistantText() ?? "" }); break;
		case "help": panel({ kind: "help" }); break;
		case "quit": host.emit({ type: "close" }); break;
		default: return false;
	}
	return true;
}
