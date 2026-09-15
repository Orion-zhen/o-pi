import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GuiHost } from "./host.ts";

export const builtinCommands = [
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
].map(([name = "", description = ""]) => ({ name, description }));

/** 仅适配 InteractiveMode 的界面命令。扩展命令和模板继续交给 SDK prompt。 */
export async function runBuiltin(host: GuiHost, text: string): Promise<boolean> {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return false;
	const name = match[1];
	const args = match[2]?.trim() ?? "";
	const session = host.runtime.session;
	if (!name || session.extensionRunner.getCommand(name)) return false;
	const panel = (title: string, value: unknown = null) => host.emit({ type: "panel", title, value });
	switch (name) {
		case "new":
			await host.dispatch({ action: "new" });
			break;
		case "resume":
			await host.dispatch(
				args ? { action: "switch", path: path.resolve(host.runtime.cwd, args) } : { action: "sessions" },
			);
			if (!args) panel("会话列表");
			break;
		case "tree":
		case "fork":
			await host.dispatch(args ? { action: "fork", entryId: args } : { action: "tree" });
			break;
		case "name": {
			const value = args || (await host.dialogs.ask("input", "会话名称", "", [], session.sessionName ?? ""));
			if (value) await host.dispatch({ action: "rename", name: value });
			break;
		}
		case "model":
		case "scoped-models":
			panel("模型");
			break;
		case "thinking":
			if (args) await host.dispatch({ action: "thinking", level: args });
			else panel("模型");
			break;
		case "settings":
			panel("设置");
			break;
		case "login":
		case "logout":
			panel("认证");
			break;
		case "compact":
			await host.dispatch({ action: "compact", instructions: args });
			break;
		case "export":
			await host.dispatch({ action: "export", format: args === "jsonl" ? "jsonl" : "html" });
			break;
		case "import":
			if (args)
				await host.dispatch({
					action: "import",
					content: await readFile(path.resolve(host.runtime.cwd, args), "utf8"),
				});
			else panel("导入会话");
			break;
		case "reload":
			await host.dispatch({ action: "reload" });
			break;
		case "copy":
			panel("最后回复", session.getLastAssistantText() ?? "");
			break;
		case "help":
			panel("命令帮助", host.snapshot().commands);
			break;
		case "quit":
			host.emit({ type: "close" });
			break;
		default:
			return false;
	}
	return true;
}
