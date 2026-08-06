import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAncestorPiSkillPaths } from "../../src/skill-context/discovery.js";

/** 让项目 .pi/skills 与 .agents/skills 一样支持从 cwd 向上发现。 */
export default function projectSkillsExtension(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("resources_discover", (event, ctx) => ({
		skillPaths: discoverAncestorPiSkillPaths({
			cwd: event.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		}),
	}));
}
