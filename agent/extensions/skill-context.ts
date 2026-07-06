import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSkillContext } from "../../src/skill-context/index.js";

/** 注册 host-side skill context：/skill 命令、上下文注入和重复 read 防护。 */
export default function skillContextExtension(pi: ExtensionAPI): void {
	registerSkillContext(pi);
}
