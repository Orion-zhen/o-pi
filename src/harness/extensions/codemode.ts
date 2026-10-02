import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codemodeHiddenDeclarations } from "../codemode/loadout.ts";

/** 沿用原生提示词和执行器，只收紧 only 模式的声明与顶层调用。 */
export default function codemode(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.parentToolCallId !== undefined || !pi.getActiveTools().includes("codemode")) return;
		const tool = pi.getAllTools().find((tool) => tool.name === event.toolName);
		if (event.toolName === "tool_search") return { block: true, reason: "Use searchTools() inside a codemode script." };
		if (tool?.exposure !== "model-only") {
			return { block: true, reason: "Codemode is active. Call this tool from a codemode script." };
		}
	});
	createCodemodeExtension({ mode: "only" })({
		...pi,
		registerTool(tool) {
			pi.registerTool({
				...tool,
				prepareLoadout(loadout) {
					return {
						...tool.prepareLoadout?.(loadout),
						hiddenDeclarations: codemodeHiddenDeclarations(loadout.declared.map((tool) => ({
							name: tool.name, exposure: loadout.getExposure(tool.name),
						}))),
					};
				},
			});
		},
	});
}
