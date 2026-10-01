import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODEMODE_DESCRIPTION, prepareCodemodeLoadout } from "../codemode/description.ts";

/** 复用原生 schema 和执行闭包，精简声明并限制脚本模式下的顶层调用。 */
export default function codemode(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.parentToolCallId !== undefined || !pi.getActiveTools().includes("codemode")) return;
		const tool = pi.getAllTools().find((tool) => tool.name === event.toolName);
		if (event.toolName === "tool_search") return { block: true, reason: "Use searchTools() inside a codemode script." };
		if (tool?.exposure !== "model-only") {
			return { block: true, reason: "Codemode is active. Call this tool from a codemode script." };
		}
	});
	createCodemodeExtension({ mode: "only", models: false })({
		...pi,
		registerTool(tool) {
			pi.registerTool({
				...tool,
				description: CODEMODE_DESCRIPTION,
				promptSnippet: "Compose tool calls with JavaScript.",
				promptGuidelines: [
					"With codemode, complete known call chains in the same script. Filter/aggregate intermediate data. Emit only answer evidence or inputs needing model judgment.",
				],
				prepareLoadout(loadout) {
					const budget = pi.getSettings().codemode?.inlineBudget;
					return prepareCodemodeLoadout(loadout,
						typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 3000);
				},
			});
		},
	});
}
