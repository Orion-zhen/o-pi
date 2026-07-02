import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** 禁用 Pi 内置工具；扩展或自定义工具保持可用。 */
export default function disableBuiltins(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const builtinToolNames = new Set(
			pi
				.getAllTools()
				.filter((tool) => isBuiltinTool(tool))
				.map((tool) => tool.name),
		);

		pi.setActiveTools(pi.getActiveTools().filter((name) => !builtinToolNames.has(name)));
	});
}

/** Pi 0.80.3 的内置工具带有 sourceInfo；名称兜底避免旧会话元数据缺失时漏关。 */
function isBuiltinTool(tool: ToolInfo): boolean {
	return tool.sourceInfo?.source === "builtin" || BUILTIN_TOOL_NAMES.has(tool.name);
}
