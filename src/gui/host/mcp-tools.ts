import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionFactory, type McpServerConfig, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMcpToolExposure, loadMcpConfig } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/config.js";
import { createModeMcpExtension } from "../../harness/extensions/mcp.ts";
import { syncToolSearch } from "../../harness/tool-search/loadout.ts";
import type { GuiToolSelectionItem } from "../mcp.ts";

const ENTRY = "gui-mcp-tools";
const SERVERS_ENTRY = "gui-mcp-servers";
type Choice = { definition: Pick<ToolDefinition, "name" | "description" | "exposure">; mcpServer: GuiToolSelectionItem["mcpServer"]; apply(): void };

/** 只控制会话工具暴露，不管理 MCP 连接。 */
export class GuiMcpTools {
	private tools = new Map<string, Choice>();
	private choices = new Map<string, boolean>();
	private serverChoices = new Map<string, boolean>();
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

	private serverEnabled(tool: Choice): boolean {
		return !tool.mcpServer || this.serverChoices.get(tool.mcpServer.name) !== false;
	}

	private publish(): void {
		syncToolSearch(this.pi);
		this.changed();
	}

	readonly register: ExtensionAPI["registerTool"] = (definition) => {
		const tool: Choice = {
			definition, mcpServer: definition.exposure === "hidden" ? undefined : this.serverInfo(definition),
			apply: () => {
				const exposure = definition.exposure ?? "direct";
				const enabled = this.serverEnabled(tool) && this.choices.get(definition.name) !== false;
				this.pi.registerTool({ ...definition, exposure: enabled ? exposure : "hidden" });
				if (enabled && exposure === "direct" && this.choices.get(definition.name) === true) {
					this.pi.setActiveTools([...new Set([...this.pi.getActiveTools(), definition.name])]);
				}
			},
		};
		this.tools.set(definition.name, tool);
		tool.apply();
		this.changed();
	};

	list(activeTools: readonly string[]): GuiToolSelectionItem[] {
		const active = new Set(activeTools);
		return [...this.tools.values()].filter((tool) => tool.definition.exposure !== "hidden").map((tool) => {
			const { name, description, exposure = "direct" } = tool.definition;
			const available = this.serverEnabled(tool);
			return {
				name, description, exposure, mcp: true,
				...(tool.mcpServer ? { mcpServer: tool.mcpServer } : {}),
				...(available ? { available: true, enabled: this.choices.get(name) !== false && (exposure === "codemode" || exposure === "deferred" || active.has(name)) }
					: { available: false, enabled: false }),
			};
		});
	}

	set(name: string, enabled: boolean): boolean {
		const tool = this.tools.get(name);
		if (!tool) return false;
		if (tool.definition.exposure !== "hidden" && this.serverEnabled(tool)) {
			this.choices.set(name, enabled);
			tool.apply();
			this.pi.appendEntry(ENTRY, Object.fromEntries(this.choices));
			this.publish();
		}
		return true;
	}

	setServers(names: readonly string[], enabled: boolean): void {
		const servers = new Set([...this.tools.values()].flatMap((tool) => tool.mcpServer ? [tool.mcpServer.name] : []));
		const changed = new Set(names.filter((name) => servers.has(name) && (this.serverChoices.get(name) !== false) !== enabled));
		if (!changed.size) return;
		for (const name of changed) this.serverChoices.set(name, enabled);
		for (const tool of this.tools.values()) if (tool.mcpServer && changed.has(tool.mcpServer.name)) tool.apply();
		this.pi.appendEntry(SERVERS_ENTRY, Object.fromEntries(this.serverChoices));
		this.publish();
	}

	restore(ctx: ExtensionContext): void {
		this.choices.clear();
		this.serverChoices.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || (entry.customType !== ENTRY && entry.customType !== SERVERS_ENTRY)) continue;
			const data: unknown = entry.data;
			if (typeof data !== "object" || data === null || Array.isArray(data)) continue;
			const pairs = Object.entries(data);
			if (!pairs.every((pair): pair is [string, boolean] => typeof pair[1] === "boolean")) continue;
			if (entry.customType === ENTRY) this.choices = new Map(pairs);
			else this.serverChoices = new Map(pairs);
		}
		for (const tool of this.tools.values()) tool.apply();
		this.publish();
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
