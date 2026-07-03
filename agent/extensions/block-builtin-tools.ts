import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

const BUILTIN_SOURCE = "builtin";

function isBuiltinTool(tool: ToolInfo): boolean {
	return tool.sourceInfo.source === BUILTIN_SOURCE;
}

/** 禁用 Pi 内置工具，仅保留扩展或 SDK 注册的工具。 */
export default function blockBuiltinTools(pi: ExtensionAPI): void {
	const disableBuiltinTools = () => {
		const builtinToolNames = new Set(pi.getAllTools().filter(isBuiltinTool).map((tool) => tool.name));
		const activeToolNames = pi.getActiveTools().filter((toolName) => !builtinToolNames.has(toolName));
		pi.setActiveTools(activeToolNames);
	};

	// session_start 触发时工具注册表已绑定；setActiveTools 会同步重建系统提示词。
	pi.on("session_start", () => {
		disableBuiltinTools();
	});

	// 防止恢复旧会话或外部配置重新启用内置工具后仍能执行。
	pi.on("tool_call", (event) => {
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		if (tool && isBuiltinTool(tool)) {
			return { block: true, reason: `Pi built-in tool '${event.toolName}' is disabled.` };
		}
		return undefined;
	});
}
