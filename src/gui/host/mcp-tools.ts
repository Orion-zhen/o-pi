import { createMcpExtension, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ToolSelectionItem } from "../../harness/tool-defaults/controller.ts";

const ENTRY = "gui-mcp-tools";
type Choice = { name: string; description: string; exposure: ToolSelectionItem["exposure"]; apply(): void };

/** 只控制会话工具暴露，不管理 MCP 连接。 */
export class GuiMcpTools {
	private tools = new Map<string, Choice>();
	private choices = new Map<string, boolean>();

	constructor(private pi: ExtensionAPI, private changed: () => void) {}

	readonly register: ExtensionAPI["registerTool"] = (tool) => {
		const exposure = tool.exposure ?? "direct";
		const apply = () => {
			this.pi.registerTool({ ...tool, exposure: this.choices.get(tool.name) === false ? "hidden" : exposure });
			if (exposure !== "hidden" && this.choices.get(tool.name) === true) {
				this.pi.setActiveTools([...new Set([...this.pi.getActiveTools(), tool.name])]);
			}
			this.changed();
		};
		this.tools.set(tool.name, { name: tool.name, description: tool.description, exposure, apply });
		apply();
	};

	list(activeTools: readonly string[]): ToolSelectionItem[] {
		const active = new Set(activeTools);
		return [...this.tools.values()].filter((tool) => tool.exposure !== "hidden").map((tool) => ({
			name: tool.name, description: tool.description, exposure: tool.exposure, available: true,
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
		return createMcpExtension({ openUrl })({
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
