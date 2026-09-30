import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CODEMODE_DESCRIPTION, prepareCodemodeLoadout } from "../codemode/description.ts";

/** 复用公开工厂，只替换注册定义中的模型可见文本。保留 schema 身份和执行闭包。 */
export default function codemode(pi: ExtensionAPI): void {
	createCodemodeExtension({ mode: "only", models: false })({
		...pi,
		registerTool(tool) {
			pi.registerTool({
				...tool,
				description: CODEMODE_DESCRIPTION,
				promptSnippet: "Compose tool calls with JavaScript.",
				promptGuidelines: [],
				prepareLoadout(loadout) {
					const budget = pi.getSettings().codemode?.inlineBudget;
					return prepareCodemodeLoadout(loadout,
						typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : 3000);
				},
			});
		},
	});
}
