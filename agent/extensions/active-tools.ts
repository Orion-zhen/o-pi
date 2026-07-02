import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";

const LEGACY_BUILTIN_TOOL_NAMES = new Set(["bash", "write", "grep", "find", "ls"]);
const REQUIRED_FILE_TOOL_NAMES = ["read", "edit"] as const;

/** 会话开始时只屏蔽不需要的 Pi 内置工具；自定义 read/edit 保持启用。 */
export default function activeTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const blockedBuiltins = new Set(
			pi
				.getAllTools()
				.filter((tool) => isBlockedBuiltin(tool))
				.map((tool) => tool.name),
		);
		const active = pi.getActiveTools().filter((name) => !blockedBuiltins.has(name));
		pi.setActiveTools(unique([...active, ...REQUIRED_FILE_TOOL_NAMES]));
	});
}

/** Pi 0.80.3 的内置工具带 sourceInfo；只按 sourceInfo 屏蔽内置版本。 */
function isBlockedBuiltin(tool: ToolInfo): boolean {
	return tool.sourceInfo?.source === "builtin" && LEGACY_BUILTIN_TOOL_NAMES.has(tool.name);
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}
