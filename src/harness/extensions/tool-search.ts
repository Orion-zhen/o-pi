import { createToolSearchExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { needsToolSearch } from "../tool-search/loadout.ts";

/** 保留原生搜索与加载行为，只投影当前请求需要的声明。 */
export default function toolSearch(pi: ExtensionAPI): void {
	createToolSearchExtension()({
		...pi,
		registerTool(tool) {
			pi.registerTool({
				...tool,
				defaultActive: true,
				prepareLoadout({ registered, declared, getExposure }) {
					const active = new Set(declared.map(({ name }) => name));
					const tools = registered.map(({ name }) => ({ name, exposure: getExposure(name) }));
					return needsToolSearch(tools, active) ? undefined : { hiddenDeclarations: [tool.name] };
				},
			});
		},
	});
}
