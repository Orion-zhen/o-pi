import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";

import { getPermissionServiceRegistry } from "../../src/pi-runtime/permission-service-registry.js";
import type { PermissionPromptContext } from "../../src/permissions/permission-types.js";

const LEGACY_BUILTIN_TOOL_NAMES = new Set(["bash", "write", "grep", "find", "ls"]);
const REQUIRED_FILE_TOOL_NAMES = ["ls", "read", "edit"] as const;

/** 同步 Pi active tools，并在工具执行前应用顶层 tools 权限。 */
export default function activeTools(pi: ExtensionAPI): void {
	const registry = getPermissionServiceRegistry();

	pi.on("session_start", async (_event, ctx) => {
		await applyActiveToolPolicy(pi, ctx);
	});
	pi.on("resources_discover", async (event, ctx) => {
		if (event.reason === "reload") await applyActiveToolPolicy(pi, ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await applyActiveToolPolicy(pi, ctx);
		return {};
	});
	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName.trim();
		if (toolName === "") return { block: true, reason: "Tool call was blocked because no tool name was provided." };

		const allTools = pi.getAllTools();
		if (!hasAllowedRegistration(toolName, allTools)) {
			return { block: true, reason: `Tool '${toolName}' is not registered or is disabled by runtime policy.` };
		}

		const service = await registry.serviceFor(ctx);
		const authorization = await service.authorizeToolCall({
			toolCallId: event.toolCallId,
			toolName,
			normalizedToolInput: event.input,
			promptContext: toolPromptContextFromUi(ctx, 120000),
		});
		if (!authorization.ok) return { block: true, reason: authorization.message };
		return undefined;
	});
}

async function applyActiveToolPolicy(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const service = await getPermissionServiceRegistry().serviceFor(ctx);
	const allTools = pi.getAllTools();
	const candidates = unique([...pi.getActiveTools(), ...REQUIRED_FILE_TOOL_NAMES]);
	const allowed: string[] = [];
	for (const name of candidates) {
		if (!hasAllowedRegistration(name, allTools)) continue;
		const evaluation = await service.explainTool(name);
		if (evaluation.effect !== "deny") allowed.push(name);
	}
	pi.setActiveTools(allowed);
}

/** Pi 0.80.3 的内置工具带 sourceInfo；只按 sourceInfo 屏蔽内置版本。 */
function isBlockedBuiltin(tool: ToolInfo): boolean {
	return tool.sourceInfo?.source === "builtin" && LEGACY_BUILTIN_TOOL_NAMES.has(tool.name);
}

function hasAllowedRegistration(toolName: string, allTools: ToolInfo[]): boolean {
	const matches = allTools.filter((tool) => tool.name === toolName);
	if (matches.length === 0) return false;
	return matches.some((tool) => !isBlockedBuiltin(tool));
}

function toolPromptContextFromUi(ctx: ExtensionContext, timeoutMs: number): PermissionPromptContext {
	return {
		hasUI: ctx.hasUI,
		timeoutMs,
		prompt: async (request, evaluation) => {
			const allowed = await ctx.ui.confirm(
				`Permission ${evaluation.effect}: ${request.toolName}`,
				[`reason: ${evaluation.reason}`, `input: ${previewInput(request.normalizedToolInput)}`].join("\n"),
				{ timeout: timeoutMs },
			);
			return { decision: allowed ? "allow-once" : "deny" };
		},
	};
}

function previewInput(value: unknown): string {
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return "undefined";
		return text.length > 500 ? `${text.slice(0, 500)}...` : text;
	} catch {
		return "[unserializable]";
	}
}

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}
