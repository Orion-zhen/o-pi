import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgentsPromptPaths } from "../../src/prompt-resources/discovery.js";

/** 让 Pi prompt templates 额外发现 ~/.agents/prompts 和受信任项目的 .agents/prompts。 */
export default function agentsPromptsExtension(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("resources_discover", (event, ctx) => ({
		promptPaths: discoverAgentsPromptPaths({
			cwd: event.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		}),
	}));
}
