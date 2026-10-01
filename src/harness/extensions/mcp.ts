import { createMcpExtension, type ExtensionFactory, type McpExtensionOptions, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { isSearchableTool, syncToolSearch } from "../tool-search/loadout.ts";

/** 从实际开放的 MCP 工具生成摘要，不复制连接状态，也不解析上游提示词。 */
function serverSummary(tools: readonly ToolInfo[]): string {
	const namespaces = new Map<string, string>();
	for (const tool of tools) {
		const namespace = tool.namespace;
		if (!isSearchableTool(tool) || !namespace?.name.startsWith("mcp__")) continue;
		const summary = (namespace.description ?? namespace.instructions ?? "").trim().split(/\r?\n/)[0]?.slice(0, 250);
		namespaces.set(namespace.name, `- ${namespace.name}${summary ? `: ${summary}` : ""}`);
	}
	const lines: string[] = [];
	let length = 0;
	for (const [, line] of [...namespaces].sort(([a], [b]) => a.localeCompare(b))) {
		if (length + line.length + 1 > 4096) break;
		lines.push(line);
		length += line.length + 1;
	}
	return lines.join("\n");
}

/** 三端复用原生 MCP，仅接管发现入口和模型可见摘要。 */
export function createModeMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		createMcpExtension(options)({
			...pi,
			registerTool(tool) {
				pi.registerTool(tool);
				syncToolSearch(pi);
			},
			setActiveTools(names) {
				// MCP 只能改变自己的工具集合，不能将普通会话切换为脚本模式。
				const scripted = pi.getActiveTools().includes("codemode");
				const next = names.filter((name) => name !== "tool_search" && (name !== "codemode" || scripted));
				syncToolSearch(pi, next);
			},
		});
		pi.on("before_agent_start", (event) => {
			syncToolSearch(pi);
			const summary = serverSummary(pi.getAllTools());
			if (summary) event.systemPromptOptions.sections.mcp_servers = summary;
			else delete event.systemPromptOptions.sections.mcp_servers;
		});
	};
}

export default createModeMcpExtension();
