import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory, type McpServerConfig, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMcpToolExposure, loadMcpConfig } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { createModeMcpExtension } from "../../harness/extensions/mcp.ts";
import { syncToolSearch } from "../../harness/tool-search/loadout.ts";
import type { GuiToolSelectionItem } from "../mcp.ts";

const ENTRY = "gui-mcp-tools";
type Choice = Pick<GuiToolSelectionItem, "name" | "description" | "exposure"> & { mcpServer: GuiToolSelectionItem["mcpServer"]; apply(): void };

/** 只控制会话工具暴露，不管理 MCP 连接。 */
export class GuiMcpTools {
	private tools = new Map<string, Choice>();
	private choices = new Map<string, boolean>();
	private configuredServers = new Map<string, McpServerConfig>();

	constructor(private pi: ExtensionAPI, private changed: () => void) {}

	loadConfig(ctx: ExtensionContext) {
		const loaded = loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		this.configuredServers = new Map(loaded.servers.map(({ name, config }) => [name, config]));
		return loaded;
	}

	private serverInfo(tool: Pick<ToolDefinition, "label" | "namespace">): GuiToolSelectionItem["mcpServer"] {
		if (!tool.namespace?.name.startsWith("mcp__")) return undefined;
		// SDK 的 label 保留服务名和原始工具名，模型工具名可能被清洗或截短。
		const separator = tool.label.indexOf("/");
		const name = tool.label.slice(0, separator);
		const originalName = tool.label.slice(separator + 1);
		const config = this.configuredServers.get(name) ?? this.pi.getMcpServers().find((server) => server.name === name)?.config;
		if (!config) throw new Error(`缺少 MCP 服务配置：${name}`);
		return { name, tool: originalName, exposure: getMcpToolExposure(config, originalName) };
	}

	readonly register: ExtensionAPI["registerTool"] = (tool) => {
		const exposure = tool.exposure ?? "direct";
		const apply = () => {
			this.pi.registerTool({ ...tool, exposure: this.choices.get(tool.name) === false ? "hidden" : exposure });
			if (exposure !== "hidden" && this.choices.get(tool.name) === true) {
				this.pi.setActiveTools([...new Set([...this.pi.getActiveTools(), tool.name])]);
			}
			syncToolSearch(this.pi);
			this.changed();
		};
		this.tools.set(tool.name, {
			name: tool.name, description: tool.description, exposure, apply,
			mcpServer: exposure === "hidden" ? undefined : this.serverInfo(tool),
		});
		apply();
	};

	list(activeTools: readonly string[]): GuiToolSelectionItem[] {
		const active = new Set(activeTools);
		return [...this.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => ({
			name: tool.name, description: tool.description, exposure: tool.exposure, available: true,
			mcp: true, ...(tool.mcpServer ? { mcpServer: tool.mcpServer } : {}),
			enabled: this.choices.get(tool.name) !== false && (tool.exposure === "codemode" || tool.exposure === "deferred" || active.has(tool.name)),
		}));
	}

	set(name: string, enabled: boolean): boolean {
		const tool = this.tools.get(name);
		if (!tool) return false;
		if (tool.exposure !== "hidden") {
			this.choices.set(name, enabled);
			tool.apply();
			this.pi.appendEntry(ENTRY, Object.fromEntries(this.choices));
		}
		return true;
	}

	restore(ctx: ExtensionContext): void {
		this.choices.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const data: unknown = entry.data;
			if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
			const pairs = Object.entries(data);
			if (!pairs.every((pair): pair is [string, boolean] => typeof pair[1] === "boolean")) continue;
			this.choices = new Map(pairs);
		}
		for (const tool of this.tools.values()) tool.apply();
	}
}

export function createGuiMcpExtension({ bind, changed, showConfig, openUrl }: {
	bind: (tools: GuiMcpTools) => void; changed: () => void; showConfig: () => void; openUrl: (url: string) => void;
}): ExtensionFactory {
	return (pi) => {
		const tools = new GuiMcpTools(pi, changed);
		bind(tools);
		pi.on("session_start", (_event, ctx) => tools.restore(ctx));
		pi.on("session_tree", (_event, ctx) => tools.restore(ctx));
		return createModeMcpExtension({ openUrl, loadConfig: (ctx) => tools.loadConfig(ctx) })({
			...pi,
			registerTool: tools.register,
			registerCommand(name, command) {
				pi.registerCommand(name, name === "mcp" ? {
					...command,
					handler: async (args, ctx) => { if (args.trim()) await command.handler(args, ctx); else showConfig(); },
				} : command);
			},
		});
	};
}
